# Architecture

AI Action Inbox is a human-approval layer for AI agents. An agent proposes an
exact action; an authorized human approves, edits, or denies it; the approved
version executes at most once and produces a receipt.

## Baseline

Phase 1 commits are counted from `f3af7505d6ad59bf08657b69e4f46855415a08b3`
(repository contained only `LICENSE`).

## Decisions

| Area | Choice |
| --- | --- |
| App framework | Next.js (App Router, TypeScript) |
| Database | PostgreSQL with Drizzle ORM migrations |
| User auth | Better Auth (Google, GitHub, verified email; unconfigured methods hidden) |
| MCP | Official `@modelcontextprotocol/sdk`, Streamable HTTP |
| Email connector | Gmail API via Google OAuth (sends as the connected user) |
| Email notifications | Link-only messages through the same Gmail connector |
| Motion | `motion` (Motion for React) |
| Tests | Vitest (unit/integration), Playwright (e2e) |
| Theme | Light-mode-first; no dark theme in Phase 1 |

## Pinned versions (npm latest at 2026-09-30)

next 16.3.7, react 19.3.0, @modelcontextprotocol/sdk 1.31.0, better-auth 1.7.6,
drizzle-orm 0.45.3, drizzle-kit 0.31.11, motion 13.4.6, zod 4.6.5,
vitest 5.0.3, @playwright/test 1.63.0, pg 8.23.0.

These are candidates from the npm registry. Exact versions are locked by the
lockfile once P1-002 lands.

## Known verification gap

The build sandbox blocks `modelcontextprotocol.io` and other documentation
hosts, so the MCP specification, Claude custom-connector flow, and provider
API docs have **not** yet been verified against current official pages.
This must be done (from an unrestricted environment) before P1-022..P1-028
and the provider slices are marked complete. Tracked in `docs/release-evidence.md`.

## Delivery order

Foundation (P1-001..007) → auth and teams → connector security → MCP →
approval engine → GitHub slice → Slack → email → inbox/receipts/notifications
→ polish and release. See `docs/commit-ledger.md`.
