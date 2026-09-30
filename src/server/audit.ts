import "server-only";
import { getDb, type Db } from "@/db/client";
import { auditEvents } from "@/db/schema";
import { redact } from "@/lib/redact";

export type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type AuditInput = {
  workspaceId?: string | null;
  actorType: "user" | "mcp_client" | "system";
  actorId?: string | null;
  action: string;
  subjectType?: string;
  subjectId?: string;
  correlationId?: string;
  detail?: Record<string, unknown>;
};

/** Appends a redacted audit event. Pass a transaction so the event commits with the change. */
export async function recordAudit(input: AuditInput, exec: Executor = getDb()): Promise<void> {
  await exec.insert(auditEvents).values({
    workspaceId: input.workspaceId ?? null,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: input.action,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    correlationId: input.correlationId,
    detail: redact(input.detail ?? {}) as Record<string, unknown>,
  });
}
