# Commit ledger

Baseline: `f3af7505d6ad59bf08657b69e4f46855415a08b3`.

## Deviations from the milestone order (recorded honestly)

- **P1-029..032 were built before P1-026..028.** The MCP tools need the approval engine behind them.
- **P1-026 and P1-027 landed in one commit** (`95038b9`): tool discovery and the per-call authorization boundary
  are inseparable in code. This leaves one milestone short; a comparably meaningful substitute is planned in
  P1-068 (reliability) rather than inflating the count.
- **P1-019..P1-021** were first pushed as one combined commit; the split, per-milestone commits were then
  reconciled with a non-destructive merge (`chore: reconcile earlier combined ...`). That merge commit is not a
  milestone commit. History was not rewritten.
- The state machine's `edit` transition was changed (P1-030) so an edit keeps the proposal pending on a new
  version; `SUPERSEDED` is a derived per-version status.

## Status

| Milestone       | Status                                                    |
| --------------- | --------------------------------------------------------- |
| P1-001 – P1-044 | done (automated verification only; see `docs/testing.md`) |
| P1-045 – P1-070 | not started                                               |

Nothing in "done" implies live provider, real Claude, or deployment verification. Those remain open.
