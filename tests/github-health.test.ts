import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts, users } from "@/db/schema";
import { githubHealthTest } from "@/connectors/github/runtime";
import type { RuntimeContext } from "@/connectors/types";
import { ConnectorError } from "@/connectors/errors";
import { connectAccount } from "@/server/connectors";
import { listRepoChoices, validateGithubDestination } from "@/server/github-repos";
import { setResourceRule } from "@/server/policy";
import { createWorkspace } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeGithub, type FakeGithubOptions } from "./fake-github";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

const ctx = (
  gh: ReturnType<typeof fakeGithub>,
  over: Partial<RuntimeContext> = {},
): RuntimeContext => ({
  account: {
    id: "a1",
    workspaceId: "w1",
    externalAccountId: "583231",
    displayName: "octocat",
    grantedScopes: ["repo"],
    metadata: {},
  },
  getAccessToken: async () => gh.token,
  fetch: gh.sf,
  ...over,
});
const statuses = (r: { steps: { id: string; status: string }[] }) =>
  Object.fromEntries(r.steps.map((s) => [s.id, s.status]));

describe("GitHub health test", () => {
  it("passes with all five evidence steps and performs only read requests", async () => {
    const gh = fakeGithub();
    const r = await githubHealthTest(ctx(gh));
    expect(r.overall).toBe("pass");
    expect(statuses(r)).toEqual({
      credential: "pass",
      reachability: "pass",
      identity: "pass",
      scopes: "pass",
      destinations: "pass",
    });
    expect(r.identity).toEqual({ displayName: "octocat", externalAccountId: "583231" });
    expect(r.grantedScopes).toEqual(["repo"]);
    expect(gh.requests.every((q) => q.method === "GET")).toBe(true);
    expect(gh.issues).toHaveLength(0);
  });

  it("flags a rejected credential as needing reauthorization", async () => {
    const gh = fakeGithub({ token: "the-token-github-accepts" });
    // The stored credential is stale: GitHub no longer recognises it.
    const r = await githubHealthTest(ctx(gh, { getAccessToken: async () => "revoked-token" }));
    expect(r.overall).toBe("fail");
    expect(r.authFailed).toBe(true);
    expect(statuses(r)).toMatchObject({
      credential: "fail",
      identity: "skipped",
      scopes: "skipped",
    });
    expect(r.steps.find((s) => s.id === "credential")!.detail).toMatch(/Reconnect/);
  });

  it("reports an unreachable API without blaming the credential", async () => {
    const gh = fakeGithub({ failures: { "/zen": 503 } });
    const r = await githubHealthTest(ctx(gh));
    expect(r.overall).toBe("fail");
    expect(r.authFailed).toBeUndefined();
    expect(statuses(r)).toMatchObject({ reachability: "fail", credential: "skipped" });
  });

  it("detects a token that now belongs to a different GitHub account", async () => {
    const gh = fakeGithub({ user: { id: 999, login: "mallory" } });
    const r = await githubHealthTest(ctx(gh));
    expect(statuses(r).identity).toBe("fail");
    expect(r.identity).toBeUndefined();
    expect(r.overall).not.toBe("pass");
  });

  it("fails the permission step when issue scopes are missing, and explains public-only access", async () => {
    const weak = await githubHealthTest(ctx(fakeGithub({ scopes: "read:user" })));
    expect(statuses(weak).scopes).toBe("fail");
    const pub = await githubHealthTest(ctx(fakeGithub({ scopes: "public_repo" })));
    expect(pub.overall).toBe("pass");
    expect(pub.steps.find((s) => s.id === "scopes")!.detail).toMatch(
      /Private repositories are not included/,
    );
  });

  it("reports missing credentials cleanly", async () => {
    const gh = fakeGithub();
    const r = await githubHealthTest(
      ctx(gh, {
        getAccessToken: async () => {
          throw new ConnectorError("auth_expired", "none");
        },
      }),
    );
    expect(r.authFailed).toBe(true);
    expect(gh.requests).toHaveLength(0);
  });

  it("rate limiting is not treated as a dead credential", async () => {
    const gh = fakeGithub();
    const rl = ctx(gh, {
      fetch: async (u, i) =>
        new URL(u).pathname === "/user"
          ? new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })
          : gh.sf(u, i),
    });
    const r = await githubHealthTest(rl);
    expect(r.overall).toBe("fail");
    expect(r.authFailed).toBe(false);
    expect(r.steps.find((s) => s.id === "credential")!.detail).toMatch(/rate limiting/);
  });
});

async function setup(opts: FakeGithubOptions = {}) {
  const email = `gh${Math.random()}@example.test`;
  await signInAs(email);
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  const ws = await createWorkspace(u!.id, "Repos");
  const c = await connectAccount({
    workspaceId: ws.id,
    actorId: u!.id,
    provider: "github",
    externalAccountId: "583231",
    displayName: "octocat",
    grantedScopes: ["repo"],
    credentials: { accessToken: "gho_test_token_123" },
  });
  return { owner: u!.id, ws, c, gh: fakeGithub(opts) };
}

describe("repository access", () => {
  const repos = [
    { owner: "acme", name: "platform" },
    { owner: "acme", name: "secrets" },
    { owner: "other", name: "public", private: false },
    { owner: "acme", name: "archived", archived: true },
    { owner: "acme", name: "noissues", has_issues: false },
  ];

  it("lists usable repositories and marks which ones policy permits", async () => {
    const s = await setup({ repos });
    await setResourceRule(s.owner, s.ws.id, {
      kind: "github_repo",
      value: "acme/*",
      effect: "allow",
    });
    await setResourceRule(s.owner, s.ws.id, {
      kind: "github_repo",
      value: "acme/secrets",
      effect: "block",
    });
    const { repos: out } = await listRepoChoices(s.owner, s.c.id, 1, s.gh.sf);
    const byName = Object.fromEntries(out.map((r) => [r.fullName, r]));
    expect(Object.keys(byName).sort()).toEqual(["acme/platform", "acme/secrets", "other/public"]);
    expect(byName["acme/platform"]!.permitted).toBe(true);
    expect(byName["acme/secrets"]).toMatchObject({ permitted: false, reason: "resource_blocked" });
    expect(byName["other/public"]).toMatchObject({
      permitted: false,
      reason: "resource_not_allowed",
    });
  });

  it("is read-only and owner-only, and hides other workspaces' connections", async () => {
    const s = await setup({ repos });
    await listRepoChoices(s.owner, s.c.id, 1, s.gh.sf);
    expect(s.gh.requests.every((r) => r.method === "GET")).toBe(true);
    const other = await setup({ repos });
    await expect(listRepoChoices(other.owner, s.c.id, 1, s.gh.sf)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("validates a destination: exists, issues enabled, not archived, scope-appropriate", async () => {
    const s = await setup({
      repos: [...repos, { owner: "acme", name: "private-repo", private: true }],
    });
    expect((await validateGithubDestination(s.c.id, "acme", "platform", s.gh.sf)).ok).toBe(true);
    expect(await validateGithubDestination(s.c.id, "acme", "archived", s.gh.sf)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/archived/),
    });
    expect(await validateGithubDestination(s.c.id, "acme", "noissues", s.gh.sf)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/disabled/),
    });
    expect(await validateGithubDestination(s.c.id, "acme", "ghost", s.gh.sf)).toMatchObject({
      ok: false,
      category: "destination_inaccessible",
    });
    await getDb()
      .update(connectorAccounts)
      .set({ grantedScopes: ["public_repo"] })
      .where(eq(connectorAccounts.id, s.c.id));
    expect(await validateGithubDestination(s.c.id, "acme", "private-repo", s.gh.sf)).toMatchObject({
      ok: false,
      category: "scope_missing",
    });
  });

  it("paginates and reports when more repositories exist", async () => {
    const many = Array.from({ length: 35 }, (_, i) => ({ owner: "acme", name: `r${i}` }));
    const s = await setup({ repos: many });
    const p1 = await listRepoChoices(s.owner, s.c.id, 1, s.gh.sf);
    expect(p1.repos).toHaveLength(30);
    expect(p1.hasMore).toBe(true);
    const p2 = await listRepoChoices(s.owner, s.c.id, 2, s.gh.sf);
    expect(p2.repos).toHaveLength(5);
    expect(p2.hasMore).toBe(false);
  });
});
