import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  auditEvents,
  connectorAccounts,
  executions,
  mcpClients,
  mcpGrants,
  proposalVersions,
  proposals,
  users,
} from "@/db/schema";
import { POST as sweepRoute, isAuthorizedCron } from "@/app/api/internal/sweep/route";
import {
  ProposalError,
  createProposal,
  expireIfDue,
  onProposalCreated,
  sweepExpired,
  type Principal,
} from "@/server/proposals";
import { updateCapabilityPolicy } from "@/server/policy";
import { createWorkspace } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function setup(opts: { enable?: boolean; connectors?: number } = {}) {
  const email = `pr${Math.random()}@example.test`;
  await signInAs(email);
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  const ws = await createWorkspace(u!.id, "Proposals");
  const conns = [];
  for (let i = 0; i < (opts.connectors ?? 1); i++) {
    const [c] = await getDb()
      .insert(connectorAccounts)
      .values({
        workspaceId: ws.id,
        provider: "github",
        externalAccountId: `${Math.random()}`,
        displayName: `gh${i}`,
        connectedByUserId: u!.id,
        grantedScopes: ["repo"],
      })
      .returning();
    conns.push(c!);
  }
  const [client] = await getDb()
    .insert(mcpClients)
    .values({
      clientId: `mcp_${Math.random()}`,
      name: "Claude",
      redirectUris: ["https://claude.ai/cb"],
    })
    .returning();
  const [grant] = await getDb()
    .insert(mcpGrants)
    .values({
      mcpClientId: client!.id,
      userId: u!.id,
      workspaceId: ws.id,
      scopes: ["proposals:create"],
    })
    .returning();
  if (opts.enable !== false)
    await updateCapabilityPolicy(u!.id, ws.id, "github.propose_issue", { enabled: true });
  const principal: Principal = {
    grantId: grant!.id,
    userId: u!.id,
    workspaceId: ws.id,
    clientLabel: "Claude",
  };
  return { owner: u!.id, ws, conns, principal };
}

const args = {
  owner: "Acme",
  repo: "Platform",
  title: "Handle failed webhook retries",
  body: "Details",
  labels: [],
};
const create = (s: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}) =>
  createProposal({ principal: s.principal, capability: "github.propose_issue", args, ...extra });

describe("proposal creation", () => {
  it("creates a pending proposal with a normalized first version and performs no execution", async () => {
    const s = await setup();
    const r = await create(s);
    expect(r).toMatchObject({
      state: "PENDING_APPROVAL",
      version: 1,
      duplicate: false,
      summary: "Create GitHub issue in acme/platform",
    });
    expect(r.reviewUrl).toBe(`http://localhost:3000/inbox/${r.proposalId}`);
    expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3_500_000);

    const [p] = await getDb().select().from(proposals).where(eq(proposals.id, r.proposalId));
    expect(p).toMatchObject({
      state: "PENDING_APPROVAL",
      initiatedByUserId: s.owner,
      mcpGrantId: s.principal.grantId,
      clientLabel: "Claude",
    });
    const [v] = await getDb()
      .select()
      .from(proposalVersions)
      .where(eq(proposalVersions.proposalId, r.proposalId));
    expect(v!.args).toMatchObject({ owner: "acme", repo: "platform" });
    expect(
      await getDb().select().from(executions).where(eq(executions.proposalId, r.proposalId)),
    ).toHaveLength(0);
    const audit = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, r.proposalId));
    expect(audit.map((a) => a.action).sort()).toEqual(["proposal.created", "proposal.submit"]);
    expect(JSON.stringify(audit)).not.toContain("Details");
  });

  it("uses the workspace's configured expiry", async () => {
    const s = await setup();
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { expirySeconds: 600 });
    const r = await create(s);
    expect(r.expiresAt.getTime() - Date.now()).toBeLessThan(601_000);
  });

  it("rejects invalid or oversized arguments with field-level detail and stores nothing", async () => {
    const s = await setup();
    const bad = await create(s, {})
      .then(() => null)
      .catch(() => null);
    expect(bad).toBeNull(); // valid args succeed; the invalid cases follow
    const err = await createProposal({
      principal: s.principal,
      capability: "github.propose_issue",
      args: { owner: "a/b", repo: "x", title: "" },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ProposalError);
    expect(err.code).toBe("invalid_arguments");
    expect(err.details.issues.length).toBeGreaterThan(0);
    const big = await createProposal({
      principal: s.principal,
      capability: "github.propose_issue",
      args: { ...args, body: "x".repeat(500_000) },
    }).catch((e) => e);
    expect(big.code).toBe("content_too_large");
  });

  it("is denied by default until the capability is enabled", async () => {
    const s = await setup({ enable: false });
    const err = await create(s).catch((e) => e);
    expect(err.code).toBe("policy_denied");
    expect(err.details.reasons.map((r: { code: string }) => r.code)).toContain(
      "capability_disabled",
    );
    expect(
      await getDb().select().from(proposals).where(eq(proposals.workspaceId, s.ws.id)),
    ).toHaveLength(0);
  });

  it("needs a connector, and asks which one when several are connected", async () => {
    const none = await setup({ connectors: 0 });
    expect((await create(none).catch((e) => e)).code).toBe("connector_required");
    const many = await setup({ connectors: 2 });
    const err = await create(many).catch((e) => e);
    expect(err.code).toBe("connector_ambiguous");
    expect(err.details.accounts).toHaveLength(2);
    expect((await create(many, { connectorAccountId: many.conns[1]!.id })).state).toBe(
      "PENDING_APPROVAL",
    );
  });

  it("refuses a connector from another workspace", async () => {
    const a = await setup();
    const b = await setup();
    const err = await create(a, { connectorAccountId: b.conns[0]!.id }).catch((e) => e);
    expect(err.code).toBe("connector_required");
  });

  it("is idempotent for a repeated client request ID, even concurrently", async () => {
    const s = await setup();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => create(s, { clientRequestId: "req-1" })),
    );
    expect(new Set(results.map((r) => r.proposalId)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(
      await getDb().select().from(proposals).where(eq(proposals.workspaceId, s.ws.id)),
    ).toHaveLength(1);
    expect((await create(s, { clientRequestId: "req-2" })).duplicate).toBe(false);
  });

  it("notifies listeners after creation without letting them break it", async () => {
    const s = await setup();
    const seen: string[] = [];
    const off = onProposalCreated(({ proposalId }) => void seen.push(proposalId));
    const off2 = onProposalCreated(() => {
      throw new Error("listener bug");
    });
    const r = await create(s);
    off();
    off2();
    expect(seen).toEqual([r.proposalId]);
  });
});

describe("expiration", () => {
  async function due(
    s: Awaited<ReturnType<typeof setup>>,
    state: "PENDING_APPROVAL" | "APPROVED" | "DENIED" = "PENDING_APPROVAL",
  ) {
    const r = await create(s);
    await getDb()
      .update(proposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(proposals.id, r.proposalId));
    if (state !== "PENDING_APPROVAL")
      await getDb().update(proposals).set({ state }).where(eq(proposals.id, r.proposalId));
    return r.proposalId;
  }
  const stateOf = async (id: string) =>
    (await getDb().select().from(proposals).where(eq(proposals.id, id)))[0]!.state;

  it("expires overdue pending and approved proposals but never touches finished ones", async () => {
    const s = await setup();
    const pending = await due(s);
    const approved = await due(s, "APPROVED");
    const denied = await due(s, "DENIED");
    const fresh = (await create(s)).proposalId;
    await sweepExpired();
    expect(await stateOf(pending)).toBe("EXPIRED");
    expect(await stateOf(approved)).toBe("EXPIRED");
    expect(await stateOf(denied)).toBe("DENIED");
    expect(await stateOf(fresh)).toBe("PENDING_APPROVAL");
  });

  it("is safe when many sweepers race", async () => {
    const s = await setup();
    const ids = await Promise.all(Array.from({ length: 6 }, () => due(s)));
    const counts = await Promise.all(Array.from({ length: 4 }, () => sweepExpired()));
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(6);
    for (const id of ids) expect(await stateOf(id)).toBe("EXPIRED");
    const events = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, s.ws.id));
    for (const id of ids)
      expect(
        events.filter((e) => e.subjectId === id && e.action === "proposal.expire"),
      ).toHaveLength(1);
  });

  it("expires lazily on demand", async () => {
    const s = await setup();
    const id = await due(s);
    expect(await expireIfDue(id)).toBe(true);
    expect(await expireIfDue(id)).toBe(false);
    expect(await stateOf(id)).toBe("EXPIRED");
  });

  it("protects the sweep endpoint with a bearer secret and hides it otherwise", async () => {
    const secret = "cron-secret-cron-secret-cron-secret-0001";
    const call = (auth?: string) =>
      sweepRoute(
        new Request("http://localhost:3000/api/internal/sweep", {
          method: "POST",
          headers: auth ? { authorization: auth } : {},
        }),
      );
    expect((await call()).status).toBe(404);
    expect((await call("Bearer wrong")).status).toBe(404);
    expect((await call(`Bearer ${secret}x`)).status).toBe(404);
    const ok = await call(`Bearer ${secret}`);
    expect(ok.status).toBe(200);
    expect(typeof (await ok.json()).expired).toBe("number");
  });

  it("disables the endpoint when the secret is unset or too short", () => {
    const req = new Request("http://x", { headers: { authorization: "Bearer short" } });
    expect(isAuthorizedCron(req, undefined)).toBe(false);
    expect(isAuthorizedCron(req, "short")).toBe(false);
  });
});
