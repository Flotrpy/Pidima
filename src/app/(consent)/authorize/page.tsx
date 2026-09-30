import { approveConsentAction, denyConsentAction } from "@/app/actions/consent";
import { Button } from "@/components/ui";
import { MCP_SCOPES } from "@/mcp/scopes";
import { requireUser } from "@/server/session";
import {
  AuthorizeFatal,
  AuthorizeRedirectable,
  connectableWorkspaces,
  errorRedirect,
  readAuthorizeParams,
  validateAuthorizeRequest,
} from "@/server/mcp-consent";
import { redirect } from "next/navigation";

export const metadata = { title: "Authorize AI client" };

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const raw = readAuthorizeParams(await searchParams);

  let client, params;
  try {
    ({ client, params } = await validateAuthorizeRequest(raw));
  } catch (e) {
    if (e instanceof AuthorizeRedirectable) redirect(errorRedirect(e));
    if (e instanceof AuthorizeFatal) {
      return (
        <div className="card stack">
          <h1>This request can&apos;t be completed</h1>
          <p className="alert alert-error" role="alert">
            {e.message}. Return to the app that sent you here and try connecting again.
          </p>
        </div>
      );
    }
    throw e;
  }

  const workspaces = await connectableWorkspaces(user.id);
  const host = new URL(params.redirectUri).host;
  const hidden = Object.entries(raw).filter(([, v]) => v !== undefined);

  return (
    <div className="card stack" style={{ ["--gap" as string]: "20px" }}>
      <div>
        <h1 style={{ fontSize: "1.5rem" }}>Connect {client.name}?</h1>
        <p className="muted">
          {client.name} is asking to propose actions in AI Action Inbox on behalf of {user.name}. It
          will return to <strong>{host}</strong> afterwards.
        </p>
      </div>
      <div>
        <h2 style={{ fontSize: "1rem" }}>It will be able to</h2>
        <ul>
          {params.scopes.map((s) => (
            <li key={s}>{MCP_SCOPES[s]}</li>
          ))}
        </ul>
        <p className="alert">
          It will <strong>not</strong> be able to approve, edit, or execute anything. A person
          always reviews the exact action first.
        </p>
      </div>
      {workspaces.length === 0 ? (
        <p className="alert alert-error" role="alert">
          You don&apos;t have a workspace where you can connect AI clients. Ask a workspace owner
          for the Member or Owner role.
        </p>
      ) : (
        <form className="stack">
          {hidden.map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <div className="field">
            <label htmlFor="workspace_id">Workspace</label>
            <select
              id="workspace_id"
              name="workspace_id"
              className="select"
              defaultValue={workspaces[0]!.id}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <p className="hint">The client will only ever act inside this workspace.</p>
          </div>
          <div className="row">
            <Button type="submit" variant="primary" formAction={approveConsentAction}>
              Allow
            </Button>
            <Button type="submit" formAction={denyConsentAction}>
              Deny
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
