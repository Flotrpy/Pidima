import { Suspense } from "react";
import { removeRuleAction } from "@/app/actions/policies";
import { CapabilityForm } from "@/components/policies/CapabilityForm";
import { RuleForm } from "@/components/policies/RuleForm";
import { ChannelPicker } from "@/components/policies/ChannelPicker";
import { RepoPicker } from "@/components/policies/RepoPicker";
import { Button } from "@/components/ui";
import { requireActiveContext } from "@/server/active-workspace";
import { requirePermission } from "@/server/authz";
import { listConnectors } from "@/server/connectors";
import { listCapabilityPolicies, listResourceRules } from "@/server/policy";

export const metadata = { title: "Policies" };
export const dynamic = "force-dynamic";

const CAPS = {
  "github.propose_issue": {
    title: "GitHub issues",
    description:
      "AI clients may propose creating issues in repositories your connected GitHub account can reach.",
  },
  "slack.propose_message": {
    title: "Slack messages",
    description: "AI clients may propose messages to Slack channels.",
  },
  "email.propose_message": {
    title: "Email",
    description: "AI clients may propose emails from a connected sender.",
  },
} as const;

export default async function PoliciesPage() {
  const { user, workspace } = await requireActiveContext();
  await requirePermission(user.id, workspace.id, "policies.manage");
  const [policies, rules, connectors] = await Promise.all([
    listCapabilityPolicies(user.id, workspace.id),
    listResourceRules(user.id, workspace.id),
    listConnectors(user.id, workspace.id),
  ]);
  const github = connectors.filter((c) => c.provider === "github" && c.status === "active");
  const repoRules = rules.filter((r) => r.kind === "github_repo");
  const slack = connectors.filter((c) => c.provider === "slack" && c.status === "active");
  const channelRules = rules.filter((r) => r.kind === "slack_channel");

  return (
    <div className="stack" style={{ ["--gap" as string]: "28px" }}>
      <div>
        <h1>Policies</h1>
        <p className="muted">
          Everything is denied until you allow it. Every write also needs approval from an
          authorized person.
        </p>
      </div>

      <section className="stack" aria-labelledby="cap-h">
        <h2 id="cap-h" style={{ fontSize: "1.15rem" }}>
          What AI clients may propose
        </h2>
        {(Object.keys(CAPS) as (keyof typeof CAPS)[]).map((c) => {
          const p = policies.find((x) => x.capability === c);
          return (
            <CapabilityForm
              key={c}
              capability={c}
              title={CAPS[c].title}
              description={CAPS[c].description}
              enabled={p?.enabled ?? false}
              allowSelfApproval={p?.allowSelfApproval ?? false}
              expirySeconds={p?.expirySeconds ?? 3600}
            />
          );
        })}
      </section>

      <section className="stack" aria-labelledby="gh-h">
        <h2 id="gh-h" style={{ fontSize: "1.15rem" }}>
          GitHub repositories
        </h2>
        <p className="muted">
          With no rules, AI clients may propose issues in any repository the connected account can
          reach. As soon as you add an <strong>Allow</strong> rule, only allowed repositories are
          accepted. <strong>Block</strong> always wins. Use <code>owner/*</code> for a whole
          organization.
        </p>
        {repoRules.length > 0 ? (
          <ul className="card plain-list" aria-label="Repository rules">
            {repoRules.map((r) => (
              <li key={r.id} className="row list-row">
                <span
                  className={`badge ${r.effect === "allow" ? "badge-success" : "badge-failure"}`}
                >
                  <span aria-hidden="true">{r.effect === "allow" ? "✓" : "⊘"}</span>
                  <span>{r.effect === "allow" ? "Allow" : "Block"}</span>
                </span>
                <span className="mono" style={{ flex: 1 }}>
                  {r.value}
                </span>
                <form action={removeRuleAction}>
                  <input type="hidden" name="ruleId" value={r.id} />
                  <Button
                    type="submit"
                    small
                    variant="danger"
                    aria-label={`Remove rule for ${r.value}`}
                  >
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="alert" role="status">
            No repository rules: every reachable repository is currently permitted.
          </p>
        )}
        <div className="card">
          <RuleForm
            kind="github_repo"
            placeholder="acme/platform or acme/*"
            hint="owner/repository, or owner/* for every repository of an owner."
            effects={["allow", "block"]}
            connectors={github.map((c) => ({ id: c.id, name: c.displayName }))}
          />
        </div>
        {github.map((c) => (
          <Suspense
            key={c.id}
            fallback={<p className="muted">Loading repositories for {c.displayName}…</p>}
          >
            <RepoPicker connectorId={c.id} name={c.displayName} />
          </Suspense>
        ))}
      </section>

      <section className="stack" aria-labelledby="sl-h">
        <h2 id="sl-h" style={{ fontSize: "1.15rem" }}>
          Slack channels
        </h2>
        <p className="muted">
          AI clients can only propose messages to channels the connection is already a member of.
          With no rules, any such channel is permitted. As soon as you add an <strong>Allow</strong>{" "}
          rule, only allowed channels are accepted. <strong>Block</strong> always wins.
        </p>
        {channelRules.length > 0 ? (
          <ul className="card plain-list" aria-label="Channel rules">
            {channelRules.map((r) => (
              <li key={r.id} className="row list-row">
                <span
                  className={`badge ${r.effect === "allow" ? "badge-success" : "badge-failure"}`}
                >
                  <span aria-hidden="true">{r.effect === "allow" ? "✓" : "⊘"}</span>
                  <span>{r.effect === "allow" ? "Allow" : "Block"}</span>
                </span>
                <span className="mono" style={{ flex: 1 }}>
                  {r.value}
                </span>
                <form action={removeRuleAction}>
                  <input type="hidden" name="ruleId" value={r.id} />
                  <Button
                    type="submit"
                    small
                    variant="danger"
                    aria-label={`Remove rule for ${r.value}`}
                  >
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="alert" role="status">
            No channel rules: every channel the connection belongs to is currently permitted.
          </p>
        )}
        <div className="card">
          <RuleForm
            kind="slack_channel"
            placeholder="C0123456789"
            hint="A Slack channel ID (shown next to each channel below)."
            effects={["allow", "block"]}
            connectors={slack.map((c) => ({ id: c.id, name: c.displayName }))}
          />
        </div>
        {slack.length === 0 ? (
          <p className="muted">Connect Slack on the Connections page to manage channels.</p>
        ) : null}
        {slack.map((c) => (
          <Suspense
            key={c.id}
            fallback={<p className="muted">Loading channels for {c.displayName}…</p>}
          >
            <ChannelPicker connectorId={c.id} name={c.displayName} />
          </Suspense>
        ))}
      </section>
    </div>
  );
}
