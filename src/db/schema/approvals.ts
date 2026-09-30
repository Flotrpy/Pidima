import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth";
import { connectorAccounts } from "./connectors";
import { mcpGrants } from "./mcp";
import { capabilityEnum } from "./policies";
import { workspaces } from "./workspaces";

export const proposalStateEnum = pgEnum("proposal_state", [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "EXECUTING",
  "SUCCEEDED",
  "FAILED",
  "OUTCOME_UNKNOWN",
  "SUPERSEDED",
  "DENIED",
  "CANCELED",
  "EXPIRED",
]);

export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    capability: capabilityEnum("capability").notNull(),
    connectorAccountId: uuid("connector_account_id")
      .notNull()
      .references(() => connectorAccounts.id),
    mcpGrantId: uuid("mcp_grant_id").references(() => mcpGrants.id),
    clientLabel: text("client_label").notNull(),
    initiatedByUserId: text("initiated_by_user_id").references(() => users.id),
    state: proposalStateEnum("state").notNull().default("PENDING_APPROVAL"),
    currentVersion: integer("current_version").notNull().default(1),
    correlationId: text("correlation_id").notNull(),
    clientRequestId: text("client_request_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("proposals_inbox_idx").on(t.workspaceId, t.state, t.createdAt),
    index("proposals_expiry_idx").on(t.state, t.expiresAt),
    uniqueIndex("proposals_client_request_uq")
      .on(t.workspaceId, t.mcpGrantId, t.clientRequestId)
      .where(sql`${t.clientRequestId} is not null`),
  ],
);

/** Immutable (enforced by trigger): each edit creates a new row. */
export const proposalVersions = pgTable(
  "proposal_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** Normalized arguments exactly as they will be executed. */
    args: jsonb("args").$type<Record<string, unknown>>().notNull(),
    argsHash: text("args_hash").notNull(),
    /** Hash binding args + connector + capability + workspace + client + expiry. */
    bindingHash: text("binding_hash").notNull(),
    destination: text("destination").notNull(),
    authorType: text("author_type", { enum: ["ai", "human"] }).notNull(),
    authorUserId: text("author_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("proposal_versions_uq").on(t.proposalId, t.version)],
);

/** Append-only decision log. */
export const approvalDecisions = pgTable(
  "approval_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    proposalVersionId: uuid("proposal_version_id")
      .notNull()
      .references(() => proposalVersions.id),
    decision: text("decision", { enum: ["approve", "deny", "cancel", "edit"] }).notNull(),
    decidedByUserId: text("decided_by_user_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one approval per immutable version.
    uniqueIndex("approval_one_per_version_uq")
      .on(t.proposalVersionId)
      .where(sql`${t.decision} = 'approve'`),
  ],
);

export const executionStateEnum = pgEnum("execution_state", [
  "EXECUTING",
  "SUCCEEDED",
  "FAILED",
  "OUTCOME_UNKNOWN",
]);

export const executions = pgTable("executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  // UNIQUE: the database guarantees one execution per approved version.
  proposalVersionId: uuid("proposal_version_id")
    .notNull()
    .unique()
    .references(() => proposalVersions.id),
  proposalId: uuid("proposal_id")
    .notNull()
    .references(() => proposals.id, { onDelete: "cascade" }),
  state: executionStateEnum("state").notNull().default("EXECUTING"),
  claimedBy: text("claimed_by").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  providerResult: jsonb("provider_result").$type<Record<string, unknown>>(),
  errorCategory: text("error_category"),
  errorDetail: text("error_detail"),
});

export const executionAttempts = pgTable(
  "execution_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => executions.id, { onDelete: "cascade" }),
    attemptNo: integer("attempt_no").notNull(),
    outcome: text("outcome", { enum: ["success", "failure", "unknown"] }),
    errorCategory: text("error_category"),
    httpStatus: integer("http_status"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [unique("execution_attempt_uq").on(t.executionId, t.attemptNo)],
);

/** Immutable; corrections are new rows linking to the receipt they correct. */
export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    proposalVersionId: uuid("proposal_version_id")
      .notNull()
      .references(() => proposalVersions.id),
    kind: text("kind", { enum: ["original", "correction"] })
      .notNull()
      .default("original"),
    correctsReceiptId: uuid("corrects_receipt_id"),
    finalState: proposalStateEnum("final_state").notNull(),
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("receipts_workspace_idx").on(t.workspaceId, t.createdAt),
    uniqueIndex("receipts_one_original_uq")
      .on(t.proposalId)
      .where(sql`${t.kind} = 'original'`),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    actorType: text("actor_type", { enum: ["user", "mcp_client", "system"] }).notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    correlationId: text("correlation_id"),
    /** Redacted, bounded detail. Never content bodies or credentials. */
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["review_requested", "execution_failed", "outcome_unknown", "connector_unhealthy"],
    }).notNull(),
    proposalId: uuid("proposal_id").references(() => proposals.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("notifications_dedupe_uq").on(t.userId, t.dedupeKey),
    index("notifications_user_idx").on(t.userId, t.createdAt),
  ],
);

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [uniqueIndex("rate_limit_uq").on(t.key, t.windowStart)],
);
