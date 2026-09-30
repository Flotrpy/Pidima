# Authentication and authorization

- **Sign-in:** Better Auth with Google, GitHub and email magic link. Only fully configured methods are shown. Sessions are HttpOnly, `Secure`, SameSite cookies; sign-out revokes the session server-side.
- **Account linking:** same verified email links providers; unverified provider emails never auto-link.
- **Workspaces and roles:** Owner, Approver, Member, Viewer; every server action re-checks membership and permission (`src/lib/permissions.ts`, `src/server/authz.ts`). Removed members lose access immediately.
- **Invitations:** single-use, expiring tokens bound to a workspace and role.
- **Redirects:** `next`/callback targets must be same-origin relative paths.
- **AI clients (MCP):** dynamic client registration, authorization code + PKCE with a consent screen naming the workspace and scopes, audience-bound bearer tokens, rotating refresh tokens with reuse detection. A grant can be revoked at any time and is re-verified on every tool call. AI clients can propose and read their own proposals' status; they cannot approve.
- **Connector OAuth:** single-use state, PKCE, transactions bound to the initiating user and workspace.
