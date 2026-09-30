import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { workspaces } from "./workspaces";

/** OAuth clients registered dynamically by MCP hosts (e.g. Claude). */
export const mcpClients = pgTable("mcp_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: text("client_id").notNull().unique(),
  clientSecretHash: text("client_secret_hash"),
  name: text("name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A user's consent binding a client to one workspace with explicit scopes. */
export const mcpGrants = pgTable(
  "mcp_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mcpClientId: uuid("mcp_client_id")
      .notNull()
      .references(() => mcpClients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("mcp_grants_workspace_idx").on(t.workspaceId),
    index("mcp_grants_user_idx").on(t.userId),
  ],
);

export const mcpAuthorizationCodes = pgTable("mcp_authorization_codes", {
  codeHash: text("code_hash").primaryKey(),
  grantId: uuid("grant_id")
    .notNull()
    .references(() => mcpGrants.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  resource: text("resource").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    kind: text("kind", { enum: ["access", "refresh"] }).notNull(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => mcpGrants.id, { onDelete: "cascade" }),
    audience: text("audience").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mcp_tokens_grant_idx").on(t.grantId)],
);
