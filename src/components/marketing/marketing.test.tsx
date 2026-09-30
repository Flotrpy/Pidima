import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
import Home from "@/app/(public)/page";
import SecurityPage from "@/app/(public)/security/page";

describe("public website copy", () => {
  const html = renderToStaticMarkup(<Home />);

  it("uses the required headline, CTAs and availability line", () => {
    for (const t of [
      "Your AI can prepare the work. You decide what gets done.",
      "Start Approving Actions",
      "See How It Works",
      "Claude-first. GitHub, Slack, and email in Phase 1.",
      "Let AI prepare the work. Keep the final decision.",
    ])
      expect(html).toContain(t);
  });

  it("follows the specified section order", () => {
    const order = [
      "Without AI Action Inbox",
      "How it works",
      "A realistic review",
      "Supported actions in Phase 1",
      "Approval applies to exactly",
      "Proof of what happened",
      "Built around least privilege",
      "Connections you can trust",
    ].map((t) => html.indexOf(t));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("labels every sample as a product preview so it is not mistaken for a live account", () => {
    expect((html.match(/Product preview/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("never claims unsupported clients, certifications or guarantees", () => {
    // Disclaimers that negate a claim ("not legally binding") are allowed; affirmative claims are not.
    const all = (html + renderToStaticMarkup(<SecurityPage />)).replace(
      /not legally binding/gi,
      "",
    );
    expect(all).not.toMatch(
      /military[- ]grade|SOC ?2|ISO ?27001|HIPAA|GDPR[- ]compliant|guaranteed|100% secure|legally binding|ChatGPT|Gemini|Copilot/i,
    );
    expect(all).toMatch(/No certification, compliance attestation or independent audit is claimed/);
  });

  it("does not describe email as delivered", () => {
    expect(html).toMatch(/never delivery/);
    expect(html).not.toMatch(/delivered to (the )?inbox/i);
  });
});
