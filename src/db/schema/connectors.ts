import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  customType,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { workspaces } from "./workspaces";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const providerEnum = pgEnum("connector_provider", ["github", "slack", "gmail"]);
export const connectorStatusEnum = pgEnum("connector_status", [
  "active",
  "needs_reauth",
  "revoked",
  "disconnected",
]);

export const connectorAccounts = pgTable(
  "connector_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    displayName: text("display_name").notNull(),
    status: connectorStatusEnum("status").notNull().default("active"),
    grantedScopes: text("granted_scopes").array().notNull().default([]),
    /** Non-secret provider facts (login, team id, sender addresses). Never credentials. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    connectedByUserId: text("connected_by_user_id")
      .notNull()
      .references(() => users.id),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    lastSuccessfulTestAt: timestamp("last_successful_test_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("connector_accounts_identity_uq").on(t.workspaceId, t.provider, t.externalAccountId),
    index("connector_accounts_workspace_idx").on(t.workspaceId),
  ],
);

export const encryptedCredentials = pgTable("encrypted_credentials", {
  connectorAccountId: uuid("connector_account_id")
    .primaryKey()
    .references(() => connectorAccounts.id, { onDelete: "cascade" }),
  keyVersion: integer("key_version").notNull(),
  nonce: bytea("nonce").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  /** Optimistic-concurrency counter used by refresh coordination. */
  revision: integer("revision").notNull().default(1),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const oauthTransactions = pgTable(
  "oauth_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stateHash: text("state_hash").notNull().unique(),
    provider: providerEnum("provider").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    returnTo: text("return_to").notNull(),
    /** PKCE verifier, encrypted with the credential vault. */
    codeVerifierNonce: bytea("code_verifier_nonce"),
    codeVerifierCiphertext: bytea("code_verifier_ciphertext"),
    keyVersion: integer("key_version"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("oauth_tx_expires_idx").on(t.expiresAt)],
);

export const connectorTests = pgTable(
  "connector_tests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectorAccountId: uuid("connector_account_id")
      .notNull()
      .references(() => connectorAccounts.id, { onDelete: "cascade" }),
    startedByUserId: text("started_by_user_id").references(() => users.id),
    overall: text("overall", { enum: ["pass", "fail", "partial"] }).notNull(),
    steps: jsonb("steps")
      .$type<
        { id: string; label: string; status: "pass" | "fail" | "skipped"; detail?: string }[]
      >()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("connector_tests_account_idx").on(t.connectorAccountId, t.startedAt)],
);
