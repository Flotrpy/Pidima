import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts, users } from "@/db/schema";
import {
  dismissOnboarding,
  getOnboardingState,
  landingPath,
  skipProviders,
} from "@/server/onboarding";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function user(email: string) {
  await signInAs(email);
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  return u!.id;
}

describe("onboarding routing", () => {
  it("starts at the provider step for a fresh workspace and routes owners to setup", async () => {
    const id = await user("n1@example.test");
    const ws = await createWorkspace(id, "Fresh");
    const s = await getOnboardingState(ws.id);
    expect(s.steps.map((x) => x.status)).toEqual(["done", "current", "todo", "todo", "todo"]);
    expect(s.current).toBe("provider");
    expect(landingPath(s, true)).toBe("/onboarding");
    expect(landingPath(s, false)).toBe("/inbox");
  });

  it("derives provider completion from a real active connector", async () => {
    const id = await user("n2@example.test");
    const ws = await createWorkspace(id, "Connected");
    await getDb()
      .insert(connectorAccounts)
      .values({
        workspaceId: ws.id,
        provider: "github",
        externalAccountId: "1",
        displayName: "gh",
        connectedByUserId: id,
      });
    const s = await getOnboardingState(ws.id);
    expect(s.steps[1]?.status).toBe("done");
    expect(s.current).toBe("claude");
  });

  it("lets owners skip providers and persists it, moving on to Claude", async () => {
    const id = await user("n3@example.test");
    const ws = await createWorkspace(id, "Skipper");
    await skipProviders(id, ws.id);
    const s = await getOnboardingState(ws.id);
    expect(s.steps[1]?.status).toBe("skipped");
    expect(s.current).toBe("claude");
  });

  it("honours dismissal with an honest empty inbox, but only for owners to set", async () => {
    const owner = await user("n4@example.test");
    const ws = await createWorkspace(owner, "Dismiss");
    const member = await user("n4m@example.test");
    const { url } = await inviteMember(owner, ws.id, "n4m@example.test", "member");
    await acceptInvitation(member, url.split("/invite/")[1]!);
    await expect(dismissOnboarding(member, ws.id)).rejects.toMatchObject({ code: "forbidden" });
    await dismissOnboarding(owner, ws.id);
    const s = await getOnboardingState(ws.id);
    expect(s.dismissed).toBe(true);
    expect(landingPath(s, true)).toBe("/inbox");
  });
});
