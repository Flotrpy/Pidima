import { pgEnum } from "drizzle-orm/pg-core";

export const capabilityEnum = pgEnum("capability", [
  "github.propose_issue",
  "slack.propose_message",
  "email.propose_message",
]);
