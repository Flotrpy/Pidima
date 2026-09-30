import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvents, connectorAccounts, encryptedCredentials, users } from "@/db/schema";
import { buildAuthorizeUrl } from "@/connectors/github/oauth";
import { parseScopeHeader } from "@/connectors/github/api";
import { createSafeFetch } from "@/connectors/transport";
import { codeChallengeFor, codeVerifierFor } from "@/server/oauth-tx";
import {
  GithubConnectError,
  completeGithubConnect,
  startGithubConnect,
} from "@/server/github-connect";
import { isSameSiteNavigation } from "@/server/route-guards";
import { loadCredentials } from "@/server/vault";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function user(email: string) {
  await signInAs(email);
  return (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
}

/** A GitHub stand-in that enforces the protocol: client secret, PKCE verifier and bearer token. */
function fakeGithub(
  opts: {
    scopes?: string;
    user?: { id: number; login: string };
    expectVerifierFor?: () => string;
  } = {},
) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.origin === "https://github.com" || url.hostname === "github.com") {
      const body = new URLSearchParams(String(init?.body));
      if (
        body.get("client_secret") !== "gh-client-secret" ||
        body.get("client_id") !== "gh-client-id"
      )
        return Response.json({ error: "incorrect_client_credentials" });
      if (body.get("code") !== "good-code")
        return Response.json({ error: "bad_verification_code" });
      if (
        opts.expectVerifierFor &&
        codeChallengeFor(body.get("code_verifier") ?? "") !==
          codeChallengeFor(opts.expectVerifierFor())
      )
        return Response.json({ error: "bad_verification_code" });
      return Response.json({
        access_token: "gho_test_token_123",
        scope: opts.scopes ?? "repo",
        token_type: "bearer",
      });
    }
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== "Bearer gho_test_token_123") return new Response("{}", { status: 401 });
    return new Response(
      JSON.stringify(opts.user ?? { id: 583231, login: "octocat", name: "The Octocat" }),
      { headers: { "x-oauth-scopes": opts.scopes ?? "repo", "content-type": "application/json" } },
    );
  };
  const sf = createSafeFetch({
    allowedOrigins: ["https://api.github.com", "https://github.com"],
    fetchImpl,
  });
  return { sf, calls };
}

async function setup() {
  const owner = await user(`gh${Math.random()}@example.test`);
  const ws = await createWorkspace(owner, "GitHub");
  return { owner, ws };
}
const stateFrom = (url: string) => new URL(url).searchParams.get("state")!;

describe("GitHub authorize URL", () => {
  it("requests the chosen least-privilege scope with PKCE and never includes the secret", async () => {
    const s = await setup();
    const pub = new URL(
      await startGithubConnect({ userId: s.owner, workspaceId: s.ws.id, level: "public" }),
    );
    expect(pub.origin + pub.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(pub.searchParams.get("scope")).toBe("public_repo");
    expect(pub.searchParams.get("client_id")).toBe("gh-client-id");
    expect(pub.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/connectors/github/callback",
    );
    expect(pub.searchParams.get("code_challenge_method")).toBe("S256");
    expect(pub.searchParams.get("code_challenge")).toBe(
      codeChallengeFor(codeVerifierFor(pub.searchParams.get("state")!)),
    );
    expect(pub.toString()).not.toContain("gh-client-secret");
    const all = new URL(
      await startGithubConnect({ userId: s.owner, workspaceId: s.ws.id, level: "all" }),
    );
    expect(all.searchParams.get("scope")).toBe("repo");
    expect(
      buildAuthorizeUrl({
        clientId: "c",
        redirectUri: "https://x/cb",
        state: "s",
        codeChallenge: "ch",
        level: "public",
      }),
    ).toContain("allow_signup=false");
  });

  it("only owners can start a connection", async () => {
    const s = await setup();
    const email = `m${Math.random()}@example.test`;
    const member = await user(email);
    const { url } = await inviteMember(s.owner, s.ws.id, email, "member");
    await acceptInvitation(member, url.split("/invite/")[1]!);
    await expect(
      startGithubConnect({ userId: member, workspaceId: s.ws.id, level: "public" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("GitHub callback", () => {
  it("connects the account, records GitHub's own scope evidence and stores only encrypted credentials", async () => {
    const s = await setup();
    const state = stateFrom(
      await startGithubConnect({ userId: s.owner, workspaceId: s.ws.id, level: "all" }),
    );
    const gh = fakeGithub({ expectVerifierFor: () => codeVerifierFor(state) });
    const r = await completeGithubConnect(
      { userId: s.owner, state, code: "good-code", error: null },
      gh.sf,
    );
    expect(r.returnTo).toBe("/connections");

    const [c] = await getDb()
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.id, r.connectorAccountId));
    expect(c).toMatchObject({
      provider: "github",
      externalAccountId: "583231",
      displayName: "octocat",
      status: "active",
      grantedScopes: ["repo"],
      workspaceId: s.ws.id,
    });
    expect(c!.metadata).toMatchObject({ login: "octocat", accessLevel: "public_and_private" });
    expect(JSON.stringify(c)).not.toContain("gho_test_token_123");

    const [raw] = await getDb()
      .select()
      .from(encryptedCredentials)
      .where(eq(encryptedCredentials.connectorAccountId, c!.id));
    expect(raw!.ciphertext.toString("utf8")).not.toContain("gho_test_token_123");
    expect((await loadCredentials(c!.id))?.credentials.accessToken).toBe("gho_test_token_123");
    expect(gh.calls).toEqual([
      "POST https://github.com/login/oauth/access_token",
      "GET https://api.github.com/user",
    ]);
    const audit = await getDb().select().from(auditEvents).where(eq(auditEvents.subjectId, c!.id));
    expect(audit.map((a) => a.action)).toContain("connector.connected");
    expect(JSON.stringify(audit)).not.toContain("gho_test");
  });

  it("marks a public-only grant as such", async () => {
    const s = await setup();
    const state = stateFrom(
      await startGithubConnect({ userId: s.owner, workspaceId: s.ws.id, level: "public" }),
    );
    const r = await completeGithubConnect(
      { userId: s.owner, state, code: "good-code", error: null },
      fakeGithub({ scopes: "public_repo" }).sf,
    );
    const [c] = await getDb()
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.id, r.connectorAccountId));
    expect(c!.metadata).toMatchObject({ accessLevel: "public_only" });
  });

  it("reconnects the same GitHub account in place", async () => {
    const s = await setup();
    const run = async () => {
      const state = stateFrom(
        await startGithubConnect({ userId: s.owner, workspaceId: s.ws.id, level: "all" }),
      );
      return completeGithubConnect(
        { userId: s.owner, state, code: "good-code", error: null },
        fakeGithub().sf,
      );
    };
    const a = await run();
    const b = await run();
    expect(b.connectorAccountId).toBe(a.connectorAccountId);
    expect(
      await getDb()
        .select()
        .from(connectorAccounts)
        .where(eq(connectorAccounts.workspaceId, s.ws.id)),
    ).toHaveLength(1);
  });

  it("rejects replayed, forged and cross-user callbacks before touching GitHub", async () => {
    const s = await setup();
    const other = await user(`o${Math.random()}@example.test`);
    const state = stateFrom(
      await startGithubConnect({ userId: s.owner, workspaceId: s.ws.id, level: "all" }),
    );
    const gh = fakeGithub();
    await expect(
      completeGithubConnect({ userId: other, state, code: "good-code", error: null }, gh.sf),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      completeGithubConnect(
        { userId: s.owner, state: "forged", code: "good-code", error: null },
        gh.sf,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      completeGithubConnect(
        { userId: s.owner, state: null, code: "good-code", error: null },
        gh.sf,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(gh.calls).toHaveLength(0);
    await completeGithubConnect({ userId: s.owner, state, code: "good-code", error: null }, gh.sf);
    await expect(
      completeGithubConnect(
        { userId: s.owner, state, code: "good-code", error: null },
        fakeGithub().sf,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("handles a user who declines, a bad code, and a token lacking issue scopes without connecting", async () => {
    const s = await setup();
    const begin = async () =>
      stateFrom(await startGithubConnect({ userId: s.owner, workspaceId: s.ws.id, level: "all" }));

    const denied = await begin();
    await expect(
      completeGithubConnect(
        { userId: s.owner, state: denied, code: null, error: "access_denied" },
        fakeGithub().sf,
      ),
    ).rejects.toMatchObject({ code: "denied" });
    const bad = await begin();
    await expect(
      completeGithubConnect(
        { userId: s.owner, state: bad, code: "wrong", error: null },
        fakeGithub().sf,
      ),
    ).rejects.toMatchObject({ code: "failed" });
    const weak = await begin();
    await expect(
      completeGithubConnect(
        { userId: s.owner, state: weak, code: "good-code", error: null },
        fakeGithub({ scopes: "read:user" }).sf,
      ),
    ).rejects.toMatchObject({ code: "insufficient_scope" });
    expect(
      await getDb()
        .select()
        .from(connectorAccounts)
        .where(eq(connectorAccounts.workspaceId, s.ws.id)),
    ).toHaveLength(0);
    expect(new GithubConnectError("denied")).toBeInstanceOf(Error);
  });

  it("maps provider outages to a generic failure rather than leaking details", async () => {
    const s = await setup();
    const state = stateFrom(
      await startGithubConnect({ userId: s.owner, workspaceId: s.ws.id, level: "all" }),
    );
    const sf = createSafeFetch({
      allowedOrigins: ["https://github.com", "https://api.github.com"],
      fetchImpl: async () => new Response("oops", { status: 502 }),
    });
    await expect(
      completeGithubConnect({ userId: s.owner, state, code: "good-code", error: null }, sf),
    ).rejects.toMatchObject({ code: "failed" });
  });
});

describe("helpers", () => {
  it("parses the scope header", () => {
    expect(parseScopeHeader("repo, read:org ,")).toEqual(["repo", "read:org"]);
    expect(parseScopeHeader(null)).toEqual([]);
  });

  it("only accepts same-site navigations to start OAuth flows", () => {
    const r = (h: Record<string, string>) => new Request("http://x", { headers: h });
    expect(isSameSiteNavigation(r({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameSiteNavigation(r({ "sec-fetch-site": "none" }))).toBe(true);
    expect(isSameSiteNavigation(r({}))).toBe(true);
    expect(isSameSiteNavigation(r({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameSiteNavigation(r({ "sec-fetch-site": "same-site" }))).toBe(false);
  });
});
