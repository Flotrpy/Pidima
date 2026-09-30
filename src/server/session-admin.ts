import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { sessions } from "@/db/schema";

/**
 * Invalidates every session of a user. Call after privilege changes (role downgrade, removal)
 * so the next request must re-authenticate and pick up the new permissions.
 */
export async function revokeUserSessions(userId: string): Promise<number> {
  const deleted = await getDb()
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id });
  return deleted.length;
}
