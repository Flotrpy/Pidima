# Release evidence

Automated, live-provider, Claude, and deployment verification are reported separately. Nothing is marked verified until it has actually been run.

## 1. Automated verification (done, fixture-based)

- 568 Vitest tests in 71 files pass against real PostgreSQL 16; typecheck, lint, format and production build are clean.
- Covers: state machine and DB triggers, hash binding, execute-once races, crash recovery, policy evaluation, credential vault, OAuth/PKCE, MCP OAuth and tools through a real MCP client, GitHub/Slack/Gmail slices against stateful fakes, receipts and export, notifications, rate limits, health endpoints, and a security regression suite (isolation, forged links, replay, substitution, injection, leakage).
- Browser: 19 Playwright/axe checks on public pages (responsive, keyboard, reduced motion) in real Chromium.

## 2. Live provider verification (NOT done)

Needs: a real GitHub OAuth App, Slack app, and Google OAuth client (Gmail `gmail.send`; test users until Google verification). Provider API shapes were implemented from documentation knowledge; the build sandbox could not reach provider docs or APIs, so they are unconfirmed against live services.

## 3. Claude acceptance (NOT done)

Needs the app reachable over public HTTPS and a real Claude custom-connector test (add `APP_URL/api/mcp`, authorize, list tools, propose, poll status). The MCP flow is verified only with the official TypeScript SDK client against this server.

## 4. Deployment (NOT done)

Needs a Postgres host, a domain with HTTPS, secrets (see `.env.example`), migrations run, and a scheduler calling `/api/internal/sweep`. Procedures and checklist: `docs/deployment.md`, `docs/operations.md`. A `Dockerfile` exists but has not been built in the sandbox.

## Known gaps

- No authenticated-browser Playwright flows (sign-in, approve/edit/deny in the UI); covered at service level only. Pages such as `/invite` were not exercised in a browser.
- No `/settings` page; no workspace/account erasure flow.
- Slack and Gmail outcomes cannot be reconciled after an ambiguous write; they surface as `OUTCOME_UNKNOWN` for human verification.
- GitHub OAuth App scopes are coarse.
