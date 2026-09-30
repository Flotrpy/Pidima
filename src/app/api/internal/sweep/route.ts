import { timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";
import { sweepExpired } from "@/server/proposals";

export const dynamic = "force-dynamic";

/** Constant-time bearer check. An unset or short secret means the endpoint is disabled. */
export function isAuthorizedCron(req: Request, secret: string | undefined): boolean {
  if (!secret || secret.length < 32) return false;
  const given = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Scheduled maintenance: expire overdue proposals. Idempotent and safe to run on every instance. */
export async function POST(req: Request) {
  // Indistinguishable from a missing route when unconfigured or unauthorized.
  if (!isAuthorizedCron(req, getEnv().CRON_SECRET))
    return new Response("Not found", { status: 404 });
  const expired = await sweepExpired();
  return Response.json({ expired });
}
