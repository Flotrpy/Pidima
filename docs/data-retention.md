# Data retention

| Data                                     | Kept                                          | Notes                                                                                     |
| ---------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Proposals, versions, decisions, receipts | Until workspace deletion                      | Immutable by trigger; the record of what was approved.                                    |
| Audit events                             | 400 days (`AUDIT_RETENTION_DAYS`, minimum 30) | Purged by the sweep only, inside a transaction that opts in to the append-only exception. |
| Connector credentials                    | While connected                               | Deleted on disconnect/revoke. Encrypted at rest (AES-256-GCM, keys outside DB).           |
| MCP access/refresh tokens                | Until expiry or revocation                    | Stored hashed.                                                                            |
| OAuth transactions                       | Minutes (single use)                          | Expired rows are ignored.                                                                 |
| Rate-limit counters                      | 1 hour                                        | Purged by the sweep.                                                                      |
| Notifications                            | Until read and workspace deletion             | Email notifications contain no action content.                                            |
| Logs                                     | Per your log platform                         | Redacted; no tokens, bodies or recipients.                                                |

Proposal content (issue bodies, messages, email bodies) is stored in `proposal_versions` so approvals stay reviewable. Deleting individual proposals is intentionally unsupported. An owner can close a workspace in Settings: it disconnects connectors (credentials deleted), revokes AI client access and hides the workspace, but retained records stay in the database. Hard erasure and per-user account deletion are **not implemented in Phase 1** and must be done at the database level by an operator.
