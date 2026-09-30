import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./auth";

export type SessionUser = { id: string; name: string; email: string };

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return null;
  const { id, name, email } = session.user;
  return { id, name, email };
}

/** Server-side session check; unauthenticated callers are sent to sign-in. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  return user;
}
