import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { proposalVersions, proposals } from "@/db/schema";
import { argsHash, bindingHash } from "@/approvals/hashing";
import { getCapability } from "@/connectors/registry";
import type { Executor } from "./audit";

export class IntegrityError extends Error {
  constructor() {
    super(
      "Proposal content does not match its recorded hash. It will not be approved or executed.",
    );
  }
}

type ProposalRow = typeof proposals.$inferSelect;
export type VersionRow = typeof proposalVersions.$inferSelect;

export function computeHashes(
  proposal: Pick<
    ProposalRow,
    "workspaceId" | "capability" | "connectorAccountId" | "mcpGrantId" | "clientLabel" | "expiresAt"
  >,
  args: Record<string, unknown>,
  destination: string,
) {
  return {
    argsHash: argsHash(args),
    bindingHash: bindingHash({
      workspaceId: proposal.workspaceId,
      capability: proposal.capability,
      connectorAccountId: proposal.connectorAccountId,
      destination,
      args,
      client: { grantId: proposal.mcpGrantId, label: proposal.clientLabel },
      expiresAt: proposal.expiresAt,
    }),
  };
}

/**
 * Appends an immutable version. Arguments are re-parsed through the capability's schema so the
 * stored form is always the canonical, normalized one. Rows can never be updated afterwards
 * (database trigger).
 */
export async function insertVersion(
  exec: Executor,
  input: {
    proposal: ProposalRow;
    version: number;
    args: unknown;
    author: { type: "ai" } | { type: "human"; userId: string };
  },
): Promise<VersionRow> {
  const def = getCapability(input.proposal.capability);
  if (!def) throw new Error("Unknown capability");
  const args = def.argsSchema.parse(input.args) as Record<string, unknown>;
  const destination = def.destination(args);
  const hashes = computeHashes(input.proposal, args, destination);
  const [row] = await exec
    .insert(proposalVersions)
    .values({
      proposalId: input.proposal.id,
      version: input.version,
      args,
      argsHash: hashes.argsHash,
      bindingHash: hashes.bindingHash,
      destination,
      authorType: input.author.type,
      authorUserId: input.author.type === "human" ? input.author.userId : null,
    })
    .returning();
  return row!;
}

export async function getVersion(
  exec: Executor,
  proposalId: string,
  version: number,
): Promise<VersionRow | null> {
  const [row] = await exec
    .select()
    .from(proposalVersions)
    .where(and(eq(proposalVersions.proposalId, proposalId), eq(proposalVersions.version, version)));
  return row ?? null;
}

export async function listVersions(
  proposalId: string,
  exec: Executor = getDb(),
): Promise<VersionRow[]> {
  return exec
    .select()
    .from(proposalVersions)
    .where(eq(proposalVersions.proposalId, proposalId))
    .orderBy(desc(proposalVersions.version));
}

/** Recomputes both hashes from the stored content; any drift means tampering or corruption. */
export function assertVersionIntegrity(proposal: ProposalRow, version: VersionRow): void {
  const def = getCapability(proposal.capability);
  if (!def) throw new IntegrityError();
  const h = computeHashes(proposal, version.args, def.destination(version.args as never));
  if (
    h.argsHash !== version.argsHash ||
    h.bindingHash !== version.bindingHash ||
    def.destination(version.args as never) !== version.destination
  ) {
    throw new IntegrityError();
  }
}

/** SUPERSEDED is derived: any version older than the proposal's current version. */
export const versionStatus = (
  proposal: Pick<ProposalRow, "currentVersion">,
  v: Pick<VersionRow, "version">,
): "current" | "superseded" => (v.version === proposal.currentVersion ? "current" : "superseded");
