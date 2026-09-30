import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts, connectorTests, users } from "@/db/schema";
import { ConnectorError } from "@/connectors/errors";
import { registerRuntime } from "@/connectors/registry";
import type { ConnectorRuntime, HealthTestResult } from "@/connectors/types";
import {
  connectAccount,
  disconnectConnector,
  listConnectors,
  onConnectorChange,
  testConnector,
} from "@/server/connectors";
import { loadCredentials } from "@/server/vault";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

// A fake provider runtime: health tests are scripted, and it records that no write ever happens.
let nextHealth: () => Promise<HealthTestResult> = async () => ({
  overall: "pass",
  steps: [{ id: "credential", label: "Credential validity", status: "pass" }],
  identity: { displayName: "octocat", externalAccountId: "1" },
  grantedScopes: ["repo"],
});
const writes: string[] = [];
const runtime: ConnectorRuntime = {
  provider: "github",
  healthTest: () => nextHealth(),
  execute: async () => {
    writes.push("write");
    return { status: "succeeded", providerId: "x" };
  },
};
registerRuntime(runtime);

async function user(email: string) {
  await signInAs(email);
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  return u!.id;
}

async function setup() {
  const owner = await user(`l${Math.random()}@example.test`);
  const ws = await createWorkspace(owner, "Lifecycle");
  const c = await connectAccount({
    workspaceId: ws.id,
    actorId: owner,
    provider: "github",
    externalAccountId: "42",
    displayName: "acme",
    grantedScopes: ["repo"],
    credentials: { accessToken: "gho_secret" },
  });
  return { owner, ws, c };
}

describe("connector lifecycle", () => {
  it("connects, then reconnects the same identity in place with new credentials", async () => {
    const { owner, ws, c } = await setup();
    expect(c.reconnected).toBe(false);
    const again = await connectAccount({
      workspaceId: ws.id,
      actorId: owner,
      provider: "github",
      externalAccountId: "42",
      displayName: "acme",
      grantedScopes: ["repo", "read:org"],
      credentials: { accessToken: "gho_new" },
    });
    expect(again).toEqual({ id: c.id, reconnected: true });
    expect((await loadCredentials(c.id))?.credentials.accessToken).toBe("gho_new");
    expect(
      await getDb()
        .select()
        .from(connectorAccounts)
        .where(eq(connectorAccounts.workspaceId, ws.id)),
    ).toHaveLength(1);
  });

  it("requires connector-management permission to connect", async () => {
    const { owner, ws } = await setup();
    const email = `mem${Math.random()}@example.test`;
    const member = await user(email);
    const { url } = await inviteMember(owner, ws.id, email, "member");
    await acceptInvitation(member, url.split("/invite/")[1]!);
    await expect(
      connectAccount({
        workspaceId: ws.id,
        actorId: member,
        provider: "github",
        externalAccountId: "9",
        displayName: "x",
        grantedScopes: [],
        credentials: { accessToken: "t" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("records a passing read-only test as evidence and updates identity, scopes and timestamps", async () => {
    const { owner, c } = await setup();
    writes.length = 0;
    const r = await testConnector(owner, c.id);
    expect(r.overall).toBe("pass");
    expect(writes).toHaveLength(0);
    const [acct] = await getDb()
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.id, c.id));
    expect(acct?.displayName).toBe("octocat");
    expect(acct?.lastSuccessfulTestAt).toBeInstanceOf(Date);
    expect(
      await getDb()
        .select()
        .from(connectorTests)
        .where(eq(connectorTests.connectorAccountId, c.id)),
    ).toHaveLength(1);
  });

  it("reports a failing test as degraded without claiming the credential is dead", async () => {
    const { owner, ws, c } = await setup();
    nextHealth = async () => ({
      overall: "fail",
      steps: [{ id: "reachability", label: "API reachability", status: "fail" }],
    });
    await testConnector(owner, c.id);
    const [view] = await listConnectors(owner, ws.id);
    expect(view?.status).toBe("active");
    expect(view?.health).toBe("degraded");
    expect(view?.lastSuccessfulTestAt).toBeNull();
  });

  it("flags needs_reauth on an auth failure and recovers only after a passing test", async () => {
    const { owner, ws, c } = await setup();
    nextHealth = async () => {
      throw new ConnectorError("auth_expired", "Bad credentials");
    };
    await testConnector(owner, c.id);
    expect((await listConnectors(owner, ws.id))[0]?.health).toBe("needs_reauth");
    nextHealth = async () => ({
      overall: "pass",
      steps: [{ id: "credential", label: "Credential validity", status: "pass" }],
    });
    await getDb()
      .update(connectorAccounts)
      .set({ status: "needs_reauth" })
      .where(eq(connectorAccounts.id, c.id));
    await testConnector(owner, c.id);
    expect((await listConnectors(owner, ws.id))[0]?.health).toBe("healthy");
  });

  it("flags needs_reauth when a health result reports the credential was rejected", async () => {
    const { owner, ws, c } = await setup();
    nextHealth = async () => ({
      overall: "fail",
      authFailed: true,
      steps: [{ id: "credential", label: "Credential validity", status: "fail" }],
    });
    await testConnector(owner, c.id);
    expect((await listConnectors(owner, ws.id))[0]?.health).toBe("needs_reauth");
    nextHealth = async () => ({
      overall: "pass",
      steps: [{ id: "credential", label: "Credential validity", status: "pass" }],
    });
  });

  it("disconnects: credentials are deleted and listeners are notified", async () => {
    const { owner, ws, c } = await setup();
    const events: string[] = [];
    const off = onConnectorChange((e) => events.push(`${e.workspaceId === ws.id}:${e.change}`));
    await disconnectConnector(owner, c.id);
    off();
    expect(events).toEqual(["true:disconnected"]);
    expect(await loadCredentials(c.id)).toBeNull();
    expect((await listConnectors(owner, ws.id))[0]?.health).toBe("disconnected");
  });

  it("hides other workspaces' connections and never returns credentials in the view", async () => {
    const { owner, ws, c } = await setup();
    const stranger = await user(`s${Math.random()}@example.test`);
    await expect(testConnector(stranger, c.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(disconnectConnector(stranger, c.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(listConnectors(stranger, ws.id)).rejects.toMatchObject({ code: "not_found" });
    expect(JSON.stringify(await listConnectors(owner, ws.id))).not.toContain("gho_secret");
  });
});
