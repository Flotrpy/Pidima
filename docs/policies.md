# Policies

Default deny. A capability runs only if it is enabled for the workspace, the AI grant holds the matching scope, and the connector is healthy.

- **Roles:** who may approve per capability (Owner/Approver by default); self-approval is configurable (off by default: the requester cannot approve their own client's proposal).
- **Resource rules:** per capability allow/block/warn lists — GitHub repos, Slack channels, email recipients or domains. Block wins over allow; warn shows a banner and requires explicit confirmation.
- **Expiry:** default per capability, clamped to a maximum; expired proposals cannot be approved.
- **Evaluation points:** at propose, at decision and again at execution, so a tightened policy stops a still-pending or approved-but-unexecuted action.
- **Changes are audited** (`policy.*` events).

Evaluator: `src/approvals/policy.ts`; service: `src/server/policy.ts`; tests: `tests/policy.test.ts`, `tests/*-policy*.test.ts`.
