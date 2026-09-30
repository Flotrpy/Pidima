# Connectors

## Common behaviour

- Provider credentials are encrypted with AES-256-GCM (versioned keys from the environment, AAD bound to the
  connector account) and never leave the server. See `docs/security.md`.
- All provider traffic uses `src/connectors/transport.ts`: fixed origins, no redirects, timeouts, bounded
  bodies, `Retry-After` handling, reads retried within bounds, **writes never retried**.
- Every connector has a read-only **health test** with five evidence steps (reachability, credential, identity,
  granted permissions, destination access). Tests never create anything.

## GitHub (implemented)

- Capability: `github.propose_issue`. The only GitHub write in the codebase is `GithubClient.createIssue`.
- Auth: GitHub OAuth App, authorization-code flow with `state` and PKCE parameters. At connect time the user
  chooses **public repositories only** (`public_repo`) or **public and private** (`repo`). Granted scopes are read
  back from GitHub's `X-OAuth-Scopes` header, not assumed.
- Setup: create an OAuth App; callback URL `${APP_URL}/api/connectors/github/callback`; set
  `CONNECTOR_GITHUB_CLIENT_ID/SECRET`.
- Proposal-time checks (read-only): repository exists and is visible, issues enabled, not archived, private
  repositories only with `repo` scope, labels only when the identity has triage access.
- Execution: one `POST /repos/{owner}/{repo}/issues`. A hidden HTML comment carrying the proposal's idempotency
  key is appended to the body (disclosed on the review screen) so a lost response can be reconciled.
- Limitations: OAuth Apps only offer coarse scopes (`repo` is broad). A GitHub App with per-repository
  installation and Issues:write would be more least-privilege and is a recommended future change. PKCE support
  for GitHub OAuth Apps was not verifiable from the build sandbox.

## Slack, Email

Not yet implemented at this point in the ledger; see `docs/commit-ledger.md`.
