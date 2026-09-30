# Deployment

Status: **nothing here has been deployed or verified over real HTTPS from the build sandbox.** Everything below is what the code requires; the acceptance checklist at the end is how to verify a real deployment.

## Requirements

- Node 24, PostgreSQL 15+ (needs `pg_advisory_xact_lock`, triggers, `gen_random_uuid`), HTTPS at a stable public origin (`APP_URL`). MCP OAuth, cookies (`Secure`, HSTS) and provider callbacks all assume HTTPS.
- Any host that runs a long-lived Node process or container. A `Dockerfile` is provided. Serverless platforms work if the scheduled sweep (below) is configured, but the in-process executor then only runs on request paths; the sweep is what guarantees progress.

## Environment

See `.env.example`. Required: `APP_URL`, `DATABASE_URL`, `BETTER_AUTH_SECRET` (>=32 chars), at least one `CREDENTIAL_ENCRYPTION_KEY_V<n>` (32 random bytes, base64). `CRON_SECRET` (>=32 chars) is required for the sweep endpoint (otherwise it returns 404). Sign-in methods and connectors appear in the UI only when fully configured.

## Release procedure

1. Build the image (`docker build .`). The build needs no secrets.
2. Run migrations as a separate step: `npm run db:migrate` (uses `DATABASE_URL`). Migrations are forward-only and additive; run them **before** starting new instances. Old instances keep working across additive migrations.
3. Roll out instances. Gate traffic on `GET /api/ready` (200 only when config, credential keys and the database are all OK). `GET /api/health` is liveness only.
4. Schedule `POST /api/internal/sweep` every 1–5 minutes with `Authorization: Bearer $CRON_SECRET`. It expires overdue proposals, recovers stuck executions, dispatches approved-but-unclaimed proposals, reconciles unknown outcomes where possible, and purges old audit events and rate-limit buckets. It is idempotent and safe on every instance.

## Callback URLs to register (replace `$APP_URL`)

| App                       | Callback                                                                 |
| ------------------------- | ------------------------------------------------------------------------ |
| Sign-in: Google / GitHub  | `$APP_URL/api/auth/callback/google`, `$APP_URL/api/auth/callback/github` |
| Connector: GitHub         | `$APP_URL/api/connectors/github/callback`                                |
| Connector: Slack          | `$APP_URL/api/connectors/slack/callback`                                 |
| Connector: Google (Gmail) | `$APP_URL/api/connectors/gmail/callback`                                 |

Connector apps are separate from sign-in apps. Gmail's `gmail.send` scope is restricted: public use needs Google verification; until then only listed test users can connect.

## Claude

Add `$APP_URL/api/mcp` as a custom connector. Discovery is at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`. Behind a proxy, forward `Host`/`X-Forwarded-Proto` correctly so advertised metadata URLs match `APP_URL`.

## Multi-instance

All coordination is in Postgres (execute-once unique constraint, advisory locks for token refresh, shared rate-limit counters). No sticky sessions or shared memory are needed.

## Acceptance checklist (must be done on the real deployment)

- [ ] `/api/ready` returns 200; HTTPS certificate valid; HSTS present.
- [ ] Sign in with each configured method; sign out; session cookie is `Secure; HttpOnly`.
- [ ] Connect GitHub, Slack, Gmail; run "Test connection" on each.
- [ ] Add the MCP URL in Claude, authorize, list tools, propose one action per provider.
- [ ] Approve in the inbox; confirm a single external effect and a receipt; deny and edit paths.
- [ ] Kill an instance mid-execution in staging; confirm the sweep recovers to a terminal or `OUTCOME_UNKNOWN` state without a duplicate.
