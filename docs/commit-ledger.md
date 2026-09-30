# Commit ledger

Baseline: `f3af7505d6ad59bf08657b69e4f46855415a08b3`.

## Deviations from the milestone order (recorded honestly)

- **P1-029..032 were built before P1-026..028.** The MCP tools need the approval engine behind them.
- **P1-026 and P1-027 landed in one commit** (`95038b9`): tool discovery and the per-call authorization boundary
  are inseparable in code. The count is one short; P1-068 was split rather than padded: rate limiting is P1-068, and P1-069 also carries the
  health/readiness endpoints and container build.
- **P1-019..P1-021** were first pushed as one combined commit; the split, per-milestone commits were then
  reconciled with a non-destructive merge (`chore: reconcile earlier combined ...`). That merge commit is not a
  milestone commit. History was not rewritten.
- The state machine's `edit` transition was changed (P1-030) so an edit keeps the proposal pending on a new
  version; `SUPERSEDED` is a derived per-version status.

- **P1-058 (Gmail e2e) and P1-061..064** were built in order after the Gmail slice; notifications (P1-063) deliver
  external mail over a generic SMTP mailer rather than through the connected Gmail account. This deviates from the
  earlier plan (same Gmail connector) to keep notification delivery independent of a user's connector health.
- Several milestones were followed by small fix commits for mistakes found in verification (for example P1-050 and
  P1-059); these carry the same milestone ID in their subject.

## Status

| Milestone       | Status                                                                            |
| --------------- | --------------------------------------------------------------------------------- |
| P1-001 – P1-069 | committed; automated verification only (see `docs/testing.md`)                    |
| P1-070          | release evidence recorded in `docs/release-evidence.md`; live acceptance **open** |

Nothing above implies live provider, real Claude, or deployment verification. Those remain open.
