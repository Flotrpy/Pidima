import { disconnectAction } from "@/app/actions/connectors";
import { CONNECTORS } from "@/connectors/registry";
import type { Provider } from "@/connectors/types";
import { TestConnection } from "@/components/connections/TestConnection";
import { Button, ButtonLink } from "@/components/ui";
import { configuredConnectors, getEnv } from "@/lib/env";
import { requireActiveContext } from "@/server/active-workspace";
import { requirePermission } from "@/server/authz";
import { listConnectors, type ConnectorView } from "@/server/connectors";

export const metadata = { title: "Connections" };
export const dynamic = "force-dynamic";

const HEALTH: Record<
  ConnectorView["health"],
  { label: string; tone: string; icon: string; help: string }
> = {
  healthy: { label: "Healthy", tone: "success", icon: "✓", help: "The latest test passed." },
  degraded: {
    label: "Test failed",
    tone: "failure",
    icon: "✕",
    help: "The latest test failed. Review the steps below and retest.",
  },
  needs_reauth: {
    label: "Reconnect required",
    tone: "failure",
    icon: "!",
    help: "Authorization expired or was revoked. Reconnect to continue.",
  },
  disconnected: {
    label: "Disconnected",
    tone: "neutral",
    icon: "—",
    help: "Credentials were removed. Reconnect to use this service.",
  },
  untested: {
    label: "Not tested yet",
    tone: "pending",
    icon: "◔",
    help: "Run a test to confirm the connection works.",
  },
};

const CAPABILITY_TEXT: Record<string, string> = {
  "github.propose_issue": "Propose GitHub issues",
  "slack.propose_message": "Propose Slack messages",
  "email.propose_message": "Propose emails",
};

const fmt = (d: Date | null) =>
  d ? d.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "Never";

export default async function ConnectionsPage() {
  const { user, workspace } = await requireActiveContext();
  await requirePermission(user.id, workspace.id, "connectors.manage");
  const connectors = await listConnectors(user.id, workspace.id);
  const configured = new Set(configuredConnectors(getEnv()));

  return (
    <div className="stack" style={{ ["--gap" as string]: "24px" }}>
      <div>
        <h1>Connections</h1>
        <p className="muted">
          Connect the services Claude may propose actions for. Nothing is sent or created until an
          authorized person approves the exact request.
        </p>
      </div>

      {connectors.length === 0 ? (
        <p className="alert" role="status">
          Connect GitHub, Slack, or email before Claude can propose actions for that service.
        </p>
      ) : null}

      {(Object.keys(CONNECTORS) as Provider[]).map((provider) => {
        const meta = CONNECTORS[provider];
        const accounts = connectors.filter((c) => c.provider === provider);
        return (
          <section key={provider} className="card stack" aria-labelledby={`h-${provider}`}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 id={`h-${provider}`} style={{ fontSize: "1.15rem", margin: 0 }}>
                {meta.displayName}
              </h2>
              {configured.has(provider) ? (
                <ButtonLink
                  href={`/api/connectors/${provider}/start`}
                  variant={accounts.length ? "secondary" : "primary"}
                  small
                >
                  {accounts.length ? "Add another account" : `Connect ${meta.displayName}`}
                </ButtonLink>
              ) : (
                <span className="badge badge-neutral">Not configured by the administrator</span>
              )}
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Available: {meta.capabilities.map((c) => CAPABILITY_TEXT[c]).join(", ")}
            </p>
            {accounts.map((a) => {
              const h = HEALTH[a.health];
              return (
                <div
                  key={a.id}
                  className="stack"
                  style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}
                >
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>{a.displayName}</strong>
                    <span className={`badge badge-${h.tone}`}>
                      <span aria-hidden="true">{h.icon}</span>
                      <span>{h.label}</span>
                    </span>
                  </div>
                  <p className="muted" style={{ margin: 0 }}>
                    {h.help}
                  </p>
                  <dl className="facts">
                    <dt>Granted permissions</dt>
                    <dd>{a.grantedScopes.length ? a.grantedScopes.join(", ") : "None recorded"}</dd>
                    <dt>Last successful test</dt>
                    <dd>{fmt(a.lastSuccessfulTestAt)}</dd>
                    <dt>Last test</dt>
                    <dd>{fmt(a.lastTestedAt)}</dd>
                  </dl>
                  <div className="row">
                    {a.status !== "disconnected" && a.status !== "revoked" ? (
                      <TestConnection accountId={a.id} />
                    ) : null}
                    {configured.has(provider) ? (
                      <ButtonLink href={`/api/connectors/${provider}/start`} small>
                        Reconnect
                      </ButtonLink>
                    ) : null}
                    {a.status !== "disconnected" ? (
                      <form action={disconnectAction}>
                        <input type="hidden" name="accountId" value={a.id} />
                        <Button type="submit" small variant="danger">
                          Disconnect
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
