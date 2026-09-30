export const dynamic = "force-dynamic";

/** Liveness: the process is up. Touches nothing else, so a database outage never restarts healthy pods. */
export function GET() {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
