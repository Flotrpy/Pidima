# Remote MCP gateway

## Versions

- Protocol: MCP `2025-11-25` (the SDK's `LATEST_PROTOCOL_VERSION`); the SDK negotiates older revisions with clients.
- SDK: `@modelcontextprotocol/sdk` **1.31.0**, pinned exactly.
- Transport: Streamable HTTP via the SDK's Web Standard transport, mounted at `POST/GET/DELETE /api/mcp`.

> Verification note: the build sandbox could not reach modelcontextprotocol.io or Anthropic's
> connector documentation. Protocol behaviour above was verified against the installed SDK's own
> types and a real SDK client in `tests/mcp-endpoint.test.ts`, not against the published spec pages.
> See `docs/release-evidence.md`.

## Endpoint behaviour (implemented)

- **Stateless.** A new MCP server and transport are created per request and closed after the response,
  so any instance can serve any request and restarts lose nothing.
- **JSON responses.** `enableJsonResponse` is on; proposal tools are short request/response calls.
- **Authentication required.** Every request needs a bearer token (P1-023/P1-024). Until a token verifier
  exists the endpoint answers `401` with a `WWW-Authenticate: Bearer` challenge.
- **Origin check.** A browser-supplied `Origin` must be the app origin, `https://claude.ai`,
  `https://claude.com`, or listed in `MCP_ALLOWED_ORIGINS`; otherwise `403` (DNS-rebinding defence).
  Requests without `Origin` (server-to-server clients) are unaffected.
- **Bounds.** Request bodies over 256 KiB are refused with `413`.
- **No tools yet.** Proposal tools are added in P1-026 and each call is re-authorized in P1-027.
