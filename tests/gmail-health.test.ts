import { describe, expect, it } from "vitest";
import { gmailHealthTest, gmailValidateProposal } from "@/connectors/gmail/runtime";
import { ConnectorError } from "@/connectors/errors";
import type { RuntimeContext } from "@/connectors/types";
import { fakeGmail, type FakeGmailOptions } from "./fake-gmail";

const ctx = (
  g: ReturnType<typeof fakeGmail>,
  over: Partial<RuntimeContext> = {},
  meta: Record<string, unknown> = { email: "maya@acme.com", senderAddresses: ["maya@acme.com"] },
): RuntimeContext => ({
  account: {
    id: "a",
    workspaceId: "w",
    externalAccountId: "1234567890",
    displayName: "maya@acme.com",
    grantedScopes: [],
    metadata: meta,
  },
  getAccessToken: async () => g.access,
  fetch: g.sf,
  ...over,
});
const st = (r: { steps: { id: string; status: string }[] }) =>
  Object.fromEntries(r.steps.map((s) => [s.id, s.status]));
const health = (o: FakeGmailOptions = {}, over: Partial<RuntimeContext> = {}) => {
  const g = fakeGmail(o);
  return gmailHealthTest(ctx(g, over)).then((r) => ({ r, g }));
};

describe("Gmail health test", () => {
  it("passes with five evidence steps and never sends or reads mail", async () => {
    const { r, g } = await health();
    expect(r.overall).toBe("pass");
    expect(st(r)).toEqual({
      credential: "pass",
      reachability: "pass",
      identity: "pass",
      scopes: "pass",
      destinations: "pass",
    });
    expect(r.steps.find((s) => s.id === "destinations")!.detail).toMatch(/No test email is sent/);
    expect(g.calls.some((c) => c.path.includes("/messages"))).toBe(false);
    expect(g.sent).toHaveLength(0);
  });
  it("flags a revoked token for reauthorization", async () => {
    const { r } = await health({}, { getAccessToken: async () => "ya29.revoked" });
    expect(r.authFailed).toBe(true);
    expect(st(r)).toMatchObject({ credential: "fail", identity: "skipped" });
  });
  it("reports an unreachable Google without blaming the credential", async () => {
    const { r } = await health({ statuses: { "/certs": 503 } });
    expect(r.authFailed).toBeUndefined();
    expect(st(r)).toMatchObject({ reachability: "fail", credential: "skipped" });
  });
  it("does not treat rate limiting as a dead credential", async () => {
    const { r } = await health({ statuses: { "/userinfo": 429 } });
    expect(r.authFailed).toBe(false);
  });
  it("detects another Google account and missing send permission", async () => {
    expect(st((await health({ sub: "999" })).r).identity).toBe("fail");
    expect(st((await health({ scope: "openid email" })).r).scopes).toBe("fail");
  });
  it("reports a missing credential cleanly", async () => {
    const g = fakeGmail();
    const r = await gmailHealthTest(
      ctx(g, {
        getAccessToken: async () => {
          throw new ConnectorError("auth_expired", "x");
        },
      }),
    );
    expect(r.authFailed).toBe(true);
    expect(g.calls).toHaveLength(0);
  });
});

describe("sender validation", () => {
  const c = ctx(fakeGmail());
  it("accepts only the connected address (case-insensitively) and names the valid ones otherwise", () => {
    expect(gmailValidateProposal(c, { from: "MAYA@acme.com" }).status).toBe("ok");
    const bad = gmailValidateProposal(c, { from: "ceo@acme.com" });
    expect(bad).toMatchObject({ status: "rejected" });
    expect((bad as { message: string }).message).toMatch(/Available: maya@acme.com/);
  });
  it("rejects everything when no sender is recorded", () => {
    expect(
      gmailValidateProposal(ctx(fakeGmail(), {}, { senderAddresses: [] }), {
        from: "maya@acme.com",
      }).status,
    ).toBe("rejected");
  });
});
