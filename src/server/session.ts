import "server-only";
import { redirect } from "next/navigation";

export type SessionUser = { id: string; name: string; email: string };

/**
 * Default-deny placeholder: no session mechanism exists yet (real auth lands in P1-008),
 * so every protected request is sent to sign-in rather than trusted.
 */
export async function requireUser(): Promise<SessionUser> {
  redirect("/sign-in");
}
