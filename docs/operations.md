# Operations runbook

## Signals

- Structured JSON logs (`log.ts`) with redaction; events include `mcp.tool.*`, `execution.*`, `connector.*`. Alert on: readiness failing, `execution.unknown` spikes, `connector.needs_reauth`, sweep not called for >10 min.
- `OUTCOME_UNKNOWN` proposals appear in History under "needs verification". They are never retried automatically: a person checks the provider, then records the outcome.

## Backup and restore

- Back up Postgres (daily base backup plus WAL/PITR). The database holds encrypted credentials; **keys are not in the database**, so a backup alone cannot decrypt them.
- Back up `CREDENTIAL_ENCRYPTION_KEY_V*` in a secret manager, separately from database backups. Losing every key makes stored provider tokens unreadable; users must reconnect. Proposals, versions, decisions and receipts remain intact.
- Restore: provision DB, restore, run `npm run db:migrate` (no-op if current), start, confirm `/api/ready`. Expect a few approved-but-unclaimed proposals; the sweep dispatches them once. Anything that was `EXECUTING` at backup time is recovered to `OUTCOME_UNKNOWN`, never re-run.

## Migrations and rollback

Migrations are additive and forward-only. To roll back the application, redeploy the previous image; it tolerates additive schema. Do not hand-edit or drop the immutability/state-guard triggers; they are part of the security model (`drizzle/0002`, `0005`, `0006`).

## Key rotation

1. Generate a new key, add it as `CREDENTIAL_ENCRYPTION_KEY_V<n+1>`; it becomes active automatically (or pin with `CREDENTIAL_ENCRYPTION_ACTIVE_VERSION`). Old keys stay to decrypt existing rows.
2. New and refreshed credentials use the new key. Keep old keys until every connector has been refreshed or reconnected (check `key_version` in `encrypted_credentials`).
3. Remove an old key only when no row references it.
   Rotating `BETTER_AUTH_SECRET` signs everyone out and invalidates pending OAuth transactions; MCP tokens are unaffected.

## Connector revocation

- Planned: Connections page → Disconnect. Credentials are deleted immediately; unexecuted proposals for that connector fail closed.
- Compromised token: revoke at the provider (GitHub: Settings → Applications; Slack: app management; Google: Account → Security → Third-party access), then Disconnect here.
- AI client compromised: Clients page → Revoke. The next call fails authorization; proposals already approved still execute once; pending ones can be denied.

## Incident: suspected duplicate action

Execute-once is enforced by a unique constraint per proposal version. Check the receipt and Activity timeline (correlation id). If a provider shows two effects, compare idempotency markers (GitHub body marker) and file the evidence.

## Load

Rate limits (per minute): propose 60 per AI grant, status 120 per grant, decisions 60 per user, connector test 10. Adjust in `src/server/rate-limit.ts`. Lists are keyset-paginated; indexes cover inbox, history and activity queries.
