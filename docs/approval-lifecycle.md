# Approval lifecycle

The state machine lives in `src/approvals/state-machine.ts` and is enforced three times: in application code
(compare-and-set transitions), by a database trigger (`proposal_state_guard`), and by uniqueness constraints.

```
DRAFT ─submit→ PENDING_APPROVAL ─approve→ APPROVED ─claim→ EXECUTING ─succeed→ SUCCEEDED
                  │ edit → PENDING_APPROVAL (new version)   │ fail → FAILED   ├ fail → FAILED
                  │ deny → DENIED                           │ cancel/expire   └ mark_unknown → OUTCOME_UNKNOWN
                  │ cancel → CANCELED                                             ├ reconcile_success → SUCCEEDED
                  └ expire → EXPIRED                                              └ reconcile_failure → FAILED
```

## Versions and binding

- Every proposal has immutable **versions** (`proposal_versions`, protected by a trigger). An edit appends a new
  version and leaves the proposal pending; older versions are shown as _superseded_.
- Each version stores a canonical hash of its arguments and a **binding hash** over workspace, capability,
  connected account, destination, arguments, proposing client and expiry.
- An approval names the exact version the reviewer saw (`expectedVersion`). If it was edited meanwhile the
  approval is refused. Stored content is re-hashed before approval and again before execution.

## Deciding

- `proposals.decide` role permission **and** the approver's per-type scope (`approval_capabilities`).
- Separation of duties: the requester cannot approve unless the capability policy allows self-approval.
- Repeated or concurrent approvals return the existing state; exactly one approval exists per version.

## Executing

`executeApprovedProposal` (`src/server/executor.ts`):

1. Expire if overdue.
2. Atomically **claim** (row lock + CAS + `UNIQUE(executions.proposal_version_id)`).
3. Re-check integrity, effective policy (roles, grant, connector, scopes, destination rules, expiry, approver
   still permitted) and a provider read-only pre-flight. Any failure → `FAILED`, nothing sent.
4. Record "dispatch attempted", then perform the single provider write with a hard deadline.
5. Finalize: `SUCCEEDED`, `FAILED` (definitive), or `OUTCOME_UNKNOWN` (anything ambiguous).

**An ambiguous write is never retried.** `OUTCOME_UNKNOWN` can only be resolved by reconciliation that
positively finds the result (GitHub: a hidden marker in the issue body), or by a person verifying.

## Crash recovery

A claim older than 5 minutes with no dispatch attempt fails safely; with a dispatch attempt it becomes
`OUTCOME_UNKNOWN`. Neither is re-dispatched. `/api/internal/sweep` (Bearer `CRON_SECRET`) also expires overdue
proposals, picks up approved-but-unclaimed proposals, reconciles unknown outcomes and back-fills receipts.

## Receipts

Written in the same transaction as each settling transition; never modified. When reconciliation resolves an
unknown outcome a linked **correction** receipt is appended. Receipts hold hashes, decision makers, edits and
the provider result, not message bodies or credentials.
