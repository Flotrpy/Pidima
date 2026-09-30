# Testing

Verification is reported in four separate tiers. A pass in one tier never stands in for another.

## 1. Automated, fixture-based (runs in CI)

`npm test` runs Vitest against a **real PostgreSQL** database (`TEST_DATABASE_URL`, default
`postgres://postgres:postgres@localhost:5432/action_inbox_test`). The schema is rebuilt from the real
migrations, so triggers, unique constraints and row locks are exercised for real.

- Unit: state machine, hashing/canonicalization, policy evaluation, redaction, crypto, diff, redirects.
- Integration: OAuth (client registration, PKCE, refresh rotation and reuse detection), MCP gateway through
  the official SDK client over the real Streamable HTTP handler, proposals, edits, decisions, atomic
  execution claim, receipts, policy.
- Concurrency: duplicate approvals, concurrent claims/executors, racing sweepers and edits.
- Provider behaviour uses **fixtures**, never real services: `tests/fake-github.ts` is a stateful stand-in that
  enforces authentication and records every request. `tests/setup.ts` makes every provider "unreachable" by
  default, so a test can never contact a real service by accident.

Fixture success is **not** live verification. The fixtures encode our understanding of provider behaviour;
only tier 3 tests that understanding.

Other CI checks: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`.

## 2. Browser end-to-end (Playwright)

`npm run e2e` (Playwright, Chromium) runs against a production build. Implemented for the **public site and sign-in**:
axe WCAG 2.0/2.1/2.2 A and AA scans, no horizontal scroll from 320px to 1920px, 200% text zoom, skip link, mobile
drawer focus trap/Escape/scroll lock, keyboard-only completion of the interactive demo, visible focus, reduced motion,
landmarks and 44px touch targets.

**Not yet covered in a browser:** the authenticated application (inbox, review, approve/edit/deny, mobile approval
bar, keyboard-only review). Those flows are covered at the service level in Vitest, but a signed-in browser
session needs seeded data and a test sign-in path that is not built yet. This is a known gap.

## 3. Live provider verification (manual, controlled test accounts)

Requires real credentials that the build sandbox does not have. Procedure (to be run by a person with a
dedicated GitHub test repository, Slack test workspace and Gmail test account):

1. Configure the connector OAuth apps and callback URLs (see `docs/deployment.md`).
2. Connect the account, press **Test connection**, and confirm all steps pass.
3. Propose, approve and execute one action per connector against the test destination.
4. Confirm the provider result matches the receipt (issue URL / message link / message ID).
5. Revoke the connector and confirm a pending proposal cannot proceed.

Record dated results in `docs/release-evidence.md`.

## 4. Real Claude acceptance (manual)

Add the deployed `/api/mcp` URL as a custom connector in Claude, complete authorization, ask Claude to propose
an action, review and approve it here, and ask Claude for its status. Record the date, Claude client and result
in `docs/release-evidence.md`.

## Known gaps

- Documentation hosts (MCP spec, Claude connector docs, provider APIs) were not reachable from the build
  sandbox; behaviour was verified against installed SDK types and fixtures only.
