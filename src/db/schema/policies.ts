import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { connectorAccounts } from "./connectors";
import { capabilityEnum } from "./enums";
import { workspaces } from "./workspaces";

export const capabilityPolicies = pgTable(
  "capability_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    capability: capabilityEnum("capability").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    allowSelfApproval: boolean("allow_self_approval").notNull().default(false),
    expirySeconds: integer("expiry_seconds").notNull().default(3600),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("capability_policies_uq").on(t.workspaceId, t.capability)],
);

export const resourceKindEnum = pgEnum("resource_kind", [
  "github_repo",
  "slack_channel",
  "email_sender",
  "email_domain",
]);
export const resourceEffectEnum = pgEnum("resource_effect", ["allow", "warn", "block"]);

export const resourcePolicies = pgTable(
  "resource_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectorAccountId: uuid("connector_account_id").references(() => connectorAccounts.id, {
      onDelete: "cascade",
    }),
    kind: resourceKindEnum("kind").notNull(),
    value: text("value").notNull(),
    effect: resourceEffectEnum("effect").notNull().default("allow"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("resource_policies_uq").on(t.workspaceId, t.kind, t.value)],
);
