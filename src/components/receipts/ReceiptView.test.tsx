import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReceiptBody } from "@/server/receipts";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
import { ReceiptView } from "./ReceiptView";

const base: ReceiptBody = {
  schema: 1,
  receiptNumber: "RCPT-AAAA1111",
  kind: "original",
  generatedAt: "2026-01-01T00:00:00.000Z",
  proposal: {
    id: "p1",
    version: 2,
    capability: "github.propose_issue",
    correlationId: "corr-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
  },
  workspace: { id: "w", name: "Acme HQ" },
  client: { label: "Claude" },
  initiatedBy: { id: "u1", name: "Maya Chen" },
  decision: {
    outcome: "approved",
    by: { id: "u2", name: "Dev Patel" },
    at: "2026-01-01T00:10:00.000Z",
    reason: null,
  },
  hashes: {
    originalProposal: "a".repeat(64),
    approvedContent: "b".repeat(64),
    binding: "c".repeat(64),
  },
  humanEdits: {
    count: 1,
    versions: [
      {
        version: 2,
        by: { id: "u2", name: "Dev Patel" },
        at: "2026-01-01T00:05:00.000Z",
        reason: "Clearer",
      },
    ],
    diff: [{ key: "title", kind: "scalar", before: "Old <b>title</b>", after: "New title" }],
  },
  connector: { provider: "github", displayName: "Acme GitHub", externalAccountId: "1" },
  action: {
    destination: "acme/platform",
    summary: "Create GitHub issue in acme/platform",
    facts: [{ label: "Repository", value: "acme/platform" }],
  },
  execution: {
    state: "SUCCEEDED",
    startedAt: "2026-01-01T00:11:00.000Z",
    finishedAt: "2026-01-01T00:11:02.000Z",
    attempts: 1,
    result: {
      providerId: "1",
      url: "https://github.com/acme/platform/issues/1",
      note: null,
      details: {},
    },
    error: null,
  },
  finalState: "SUCCEEDED",
};

describe("ReceiptView", () => {
  it("shows decision makers, edits, the provider result and integrity references", () => {
    const html = renderToStaticMarkup(<ReceiptView body={base} />);
    for (const t of [
      "RCPT-AAAA1111",
      "Maya Chen",
      "Approved by Dev Patel",
      "Human edits (1)",
      "Clearer",
      "https://github.com/acme/platform/issues/1",
      "Correlation ID",
      "not a legal or cryptographic attestation",
    ])
      expect(html).toContain(t);
  });
  it("escapes content instead of rendering it as markup", () => {
    const html = renderToStaticMarkup(<ReceiptView body={base} />);
    expect(html).toContain("Old &lt;b&gt;title&lt;/b&gt;");
    expect(html).not.toContain("<b>title</b>");
  });
  it("explains unknown outcomes and links corrections without overstating", () => {
    const unknown = {
      ...base,
      finalState: "OUTCOME_UNKNOWN" as const,
      execution: {
        ...base.execution!,
        state: "OUTCOME_UNKNOWN",
        result: null,
        error: {
          category: "verification_required" as const,
          title: "Provider may have accepted the action; verification required",
          recovery: "Check the destination directly before retrying.",
        },
      },
    };
    const html = renderToStaticMarkup(
      <ReceiptView
        body={unknown}
        linked={[
          { id: "r1", number: "RCPT-1", kind: "original" },
          { id: "r2", number: "RCPT-2", kind: "correction" },
        ]}
      />,
    );
    expect(html).toContain("Check the destination directly");
    expect(html).toContain('href="/history/r2"');
    expect(html).toContain("2 receipts");
    expect(html).not.toMatch(/completed successfully/i);
  });
  it("says so when nothing was sent", () => {
    const html = renderToStaticMarkup(
      <ReceiptView
        body={{
          ...base,
          finalState: "DENIED",
          execution: null,
          decision: { ...base.decision, outcome: "denied" },
        }}
      />,
    );
    expect(html).toContain("Nothing was sent or created.");
  });
});
