# Release evidence

Automated, live-provider, Claude, and deployment verification are reported
separately. Nothing here is marked verified until it has actually been run.

## Open items

- [ ] Verify current MCP spec, Claude custom-connector flow, and provider docs
      (blocked in the build sandbox: docs hosts are not reachable).

## Automated verification (fixture-based)

- Latest run: 392 tests passing against real PostgreSQL 16; typecheck, lint, format and production build clean.
- GitHub slice verified end to end with a stateful GitHub fixture through a real MCP client. Not live.

## Not yet done

- [ ] Live GitHub, Slack and Gmail verification (needs credentials).
- [ ] Real Claude acceptance test.
- [ ] Deployed HTTPS smoke tests.
