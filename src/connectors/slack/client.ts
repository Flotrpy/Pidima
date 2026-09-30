import { ConnectorError } from "../errors";
import { categorizeStatus, retryAfterMs } from "../transport";
import type { SafeFetch } from "../types";
import { SLACK_API, parseScopeHeader, slackHeaders, throwSlack } from "./api";

export type SlackChannel = {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  isArchived: boolean;
};

type RawChannel = {
  id?: string;
  name?: string;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
};
type Envelope = { ok?: boolean; error?: string } & Record<string, unknown>;

const toChannel = (c: RawChannel): SlackChannel | null =>
  typeof c.id === "string" && typeof c.name === "string"
    ? {
        id: c.id,
        name: c.name,
        isPrivate: !!c.is_private,
        isMember: c.is_member ?? false,
        isArchived: !!c.is_archived,
      }
    : null;

/** Thin wrapper over the Slack Web API. Reads here; the single write is `postMessage`. */
export class SlackClient {
  constructor(
    private fetch: SafeFetch,
    private token: string,
  ) {}

  /** Calls a Slack method. Returns the parsed envelope and headers; throws on transport/HTTP/ok:false errors. */
  private async call<T extends Envelope>(
    method: string,
    params: Record<string, string | number | boolean> = {},
    write = false,
  ): Promise<{ data: T; headers: Headers }> {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const res = await this.fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: { ...slackHeaders(this.token), "content-type": "application/x-www-form-urlencoded" },
      body: query.toString(),
    });
    return this.parse<T>(res, write);
  }

  private async parse<T extends Envelope>(
    res: Response,
    write: boolean,
  ): Promise<{ data: T; headers: Headers }> {
    if (res.status === 429) {
      const wait = retryAfterMs(res.headers);
      throw new ConnectorError(
        "rate_limited",
        wait ? `Rate limited; retry in about ${Math.ceil(wait / 1000)}s` : "Rate limited by Slack",
      );
    }
    if (!res.ok) {
      const c = categorizeStatus(res.status, write);
      throw new ConnectorError(
        c.category,
        `Slack responded with an error (${res.status})`,
        c.maybeDispatched,
      );
    }
    let data: T;
    try {
      data = (await res.json()) as T;
    } catch {
      if (write)
        throw new ConnectorError(
          "verification_required",
          "Slack accepted the request but the response could not be read",
          true,
        );
      throw new ConnectorError("provider_unavailable", "Slack returned an unreadable response");
    }
    if (!data.ok) throwSlack(data.error, write);
    return { data, headers: res.headers };
  }

  /** Unauthenticated liveness probe (Slack's documented api.test). */
  async reachable(): Promise<{ ok: boolean; status?: number }> {
    try {
      const res = await this.fetch(`${SLACK_API}/api.test`, {
        method: "POST",
        headers: { "user-agent": "ai-action-inbox" },
      });
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false };
    }
  }

  async authTest() {
    const { data, headers } = await this.call<
      Envelope & {
        team_id?: string;
        team?: string;
        user_id?: string;
        user?: string;
        bot_id?: string;
      }
    >("auth.test");
    if (!data.team_id || !data.user_id)
      throw new ConnectorError("provider_rejected", "Unexpected response from Slack");
    return {
      teamId: data.team_id,
      team: data.team ?? data.team_id,
      userId: data.user_id,
      user: data.user ?? data.user_id,
      isBot: !!data.bot_id,
      scopes: parseScopeHeader(headers.get("x-oauth-scopes")),
    };
  }

  /** Channels visible to this token (public and private it belongs to). Bounded pagination. */
  async listChannels(maxPages = 5): Promise<{ channels: SlackChannel[]; truncated: boolean }> {
    const out: SlackChannel[] = [];
    let cursor = "";
    for (let page = 0; page < maxPages; page++) {
      const { data } = await this.call<
        Envelope & { channels?: RawChannel[]; response_metadata?: { next_cursor?: string } }
      >("conversations.list", {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const c of data.channels ?? []) {
        const ch = toChannel(c);
        if (ch) out.push(ch);
      }
      cursor = data.response_metadata?.next_cursor ?? "";
      if (!cursor) return { channels: out, truncated: false };
    }
    return { channels: out, truncated: true };
  }

  async getChannel(id: string): Promise<SlackChannel> {
    const { data } = await this.call<Envelope & { channel?: RawChannel }>("conversations.info", {
      channel: id,
    });
    const ch = data.channel ? toChannel(data.channel) : null;
    if (!ch) throw new ConnectorError("provider_rejected", "Unexpected response from Slack");
    return ch;
  }
}
