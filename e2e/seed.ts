/**
 * Seeds the e2e database through the real service layer and writes session cookies plus proposal
 * ids to e2e/.seed.json. Run with: node --conditions react-server --import tsx e2e/seed.ts
 */
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { mcpClients, mcpGrants, users } from "@/db/schema";
import { setTransportOverride } from "@/connectors/transport";
import { fakeGithub } from "../tests/fake-github";
import { getAuth } from "@/server/auth";
import { connectAccount } from "@/server/connectors";
import { outbox } from "@/server/mailer";
import { updateCapabilityPolicy } from "@/server/policy";
import { createProposal } from "@/server/proposals";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";

async function signIn(email: string, name: string) {
  const auth = getAuth();
  await auth.api.signInMagicLink({ body: { email, name }, headers: new Headers() });
  const link = outbox
    .filter((m) => m.to === email)
    .at(-1)!
    .text.match(/https?:\/\/\S+/)![0];
  const res = await auth.api.magicLinkVerify({
    query: { token: new URL(link).searchParams.get("token")! },
    headers: new Headers(),
    asResponse: true,
  });
  const cookies = res.headers.getSetCookie().map((c) => {
    const [pair] = c.split(";");
    const i = pair!.indexOf("=");
    return { name: pair!.slice(0, i), value: pair!.slice(i + 1) };
  });
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  return { id: u!.id, cookies };
}

async function main() {
  await runMigrations(process.env.DATABASE_URL!);
  const fake = fakeGithub();
  setTransportOverride("github", fake.sf);
  const stamp = Date.now();
  const owner = await signIn(`owner${stamp}@e2e.test`, "Olivia Owner");
  const approver = await signIn(`approver${stamp}@e2e.test`, "Alex Approver");
  const ws = await createWorkspace(owner.id, `E2E ${stamp}`);
  const { url } = await inviteMember(owner.id, ws.id, `approver${stamp}@e2e.test`, "approver");
  await acceptInvitation(approver.id, url.split("/invite/")[1]!);
  await connectAccount({
    workspaceId: ws.id,
    actorId: owner.id,
    provider: "github",
    externalAccountId: String(stamp),
    displayName: "octocat",
    grantedScopes: ["repo"],
    credentials: { accessToken: fake.token },
  });
  await updateCapabilityPolicy(owner.id, ws.id, "github.propose_issue", { enabled: true });
  const [client] = await getDb()
    .insert(mcpClients)
    .values({
      clientId: `e2e-${stamp}`,
      name: "Claude",
      redirectUris: ["https://claude.ai/cb"],
    } as never)
    .returning();
  const [grant] = await getDb()
    .insert(mcpGrants)
    .values({
      mcpClientId: client!.id,
      userId: owner.id,
      workspaceId: ws.id,
      scopes: ["proposals:create"],
    } as never)
    .returning();
  const principal = {
    grantId: grant!.id,
    userId: owner.id,
    workspaceId: ws.id,
    clientLabel: "Claude",
  };
  const make = async (title: string) =>
    (
      await createProposal({
        principal,
        capability: "github.propose_issue",
        args: { owner: "acme", repo: "platform", title, body: "Seeded for e2e.", labels: [] },
      })
    ).proposalId;
  const ids = {
    deny: await make("Deny me"),
    edit: await make("Edit me"),
    view: await make("View me"),
  };
  writeFileSync(
    "e2e/.seed.json",
    JSON.stringify({
      workspaceId: ws.id,
      workspaceName: ws.name,
      approverCookies: approver.cookies,
      ids,
    }),
  );
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
