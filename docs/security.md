# Security model

Core guarantees and where they are enforced/tested:

- **No action without a human decision.** Execution reads an APPROVED proposal only; proposing never calls a provider. (`proposal_state_guard` trigger; `tests/security-regression.test.ts`)
- **Exact-action binding.** A decision is bound to a version's `bindingHash`; edits create a new version and void prior approvals; integrity is re-checked at approval and execution.
- **Execute once.** `UNIQUE(executions.proposal_version_id)` plus row lock; ambiguous writes become `OUTCOME_UNKNOWN`, never retried.
- **Credentials.** AES-256-GCM with AAD, versioned env keys, never sent to browser or MCP clients; redacted logs; fail-closed receipt export scrub.
- **MCP.** Audience-bound tokens, PKCE, rotating refresh tokens with reuse detection, per-call grant re-verification, scoped status visibility.
- **Web.** CSRF/same-site checks on state-changing routes, CSP, HSTS, frame denial, open-redirect protection, hostile content rendered as text.
- **Abuse.** Shared Postgres rate limits; bounded request/response sizes; fixed provider origins, no redirects.

## Known limitations (Phase 1)

- GitHub OAuth Apps have coarse scopes (`repo`); a GitHub App would narrow this.
- Slack and Gmail have no positive lookup, so `OUTCOME_UNKNOWN` there needs human verification.
- Gmail `gmail.send` is restricted; needs Google verification for public use.
- No authenticated-browser end-to-end suite; UI behavior is covered by service-level tests and public-page Playwright/axe checks.
- Provider and Claude behavior is verified against fakes and documentation, not live services.

Report vulnerabilities privately to the repository owner.
