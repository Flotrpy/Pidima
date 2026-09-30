import { ConnectorError } from "../errors";
import { categorizeStatus, retryAfterMs } from "../transport";
import type { SafeFetch } from "../types";
import { GITHUB_API, githubHeaders, parseScopeHeader } from "./api";

export type RepoInfo = {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  archived: boolean;
  disabled: boolean;
  hasIssues: boolean;
  canCreateIssues: boolean;
  /** Applying labels needs triage (or higher) access; GitHub silently drops labels otherwise. */
  canLabel: boolean;
};

type RawRepo = {
  full_name?: string;
  name?: string;
  owner?: { login?: string };
  private?: boolean;
  archived?: boolean;
  disabled?: boolean;
  has_issues?: boolean;
  permissions?: {
    pull?: boolean;
    triage?: boolean;
    push?: boolean;
    maintain?: boolean;
    admin?: boolean;
  };
};

function toRepo(r: RawRepo): RepoInfo | null {
  if (
    typeof r.full_name !== "string" ||
    typeof r.name !== "string" ||
    typeof r.owner?.login !== "string"
  )
    return null;
  return {
    fullName: r.full_name.toLowerCase(),
    owner: r.owner.login.toLowerCase(),
    name: r.name.toLowerCase(),
    private: !!r.private,
    archived: !!r.archived,
    disabled: !!r.disabled,
    hasIssues: r.has_issues !== false,
    // Any read access can open an issue on a public repo; GitHub enforces the real rule at write time.
    canCreateIssues: !!(r.permissions?.pull ?? true),
    canLabel: !!(
      r.permissions?.triage ||
      r.permissions?.push ||
      r.permissions?.maintain ||
      r.permissions?.admin
    ),
  };
}

/** Thin, read-mostly wrapper over the GitHub REST API. All calls go through the safe transport. */
export class GithubClient {
  constructor(
    private fetch: SafeFetch,
    private token: string,
  ) {}

  private async request(path: string, init: RequestInit = {}) {
    const method = (init.method ?? "GET").toUpperCase();
    const res = await this.fetch(`${GITHUB_API}${path}`, {
      ...init,
      headers: {
        ...githubHeaders(
          this.token,
          init.method === "POST" ? { "content-type": "application/json" } : {},
        ),
      },
    });
    return { res, write: method !== "GET" };
  }

  private async json<T>(path: string): Promise<{ data: T; headers: Headers }> {
    const { res } = await this.request(path);
    if (!res.ok) throw this.errorFor(res);
    return { data: (await res.json()) as T, headers: res.headers };
  }

  errorFor(res: Response, write = false): ConnectorError {
    // GitHub uses 403 for both missing permission and rate limits; the headers say which.
    if (
      res.status === 403 &&
      (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"))
    ) {
      const wait = retryAfterMs(res.headers);
      return new ConnectorError(
        "rate_limited",
        wait ? `Rate limited; retry in about ${Math.ceil(wait / 1000)}s` : "Rate limited by GitHub",
      );
    }
    const c = categorizeStatus(res.status, write);
    return new ConnectorError(
      c.category,
      `GitHub responded with an error (${res.status})`,
      c.maybeDispatched,
    );
  }

  /** Unauthenticated reachability probe; does not consume the account's rate limit. */
  async reachable(): Promise<{ ok: boolean; status?: number }> {
    try {
      const res = await this.fetch(`${GITHUB_API}/zen`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "ai-action-inbox" },
      });
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false };
    }
  }

  async getUser() {
    const { data, headers } = await this.json<{ id: number; login: string; name?: string | null }>(
      "/user",
    );
    return {
      id: String(data.id),
      login: data.login,
      name: data.name ?? null,
      scopes: parseScopeHeader(headers.get("x-oauth-scopes")),
    };
  }

  /** One page of repositories the account can see. `truncated` means more exist than were returned. */
  async listRepos(page = 1, perPage = 30): Promise<{ repos: RepoInfo[]; hasMore: boolean }> {
    const { data, headers } = await this.json<RawRepo[]>(
      `/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
    );
    return {
      repos: data.map(toRepo).filter((r): r is RepoInfo => r !== null),
      hasMore: /rel="next"/.test(headers.get("link") ?? ""),
    };
  }

  /** Confirms the repository exists, is reachable with this token, and can hold issues. */
  async getRepo(owner: string, repo: string): Promise<RepoInfo> {
    const { data } = await this.json<RawRepo>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    );
    const info = toRepo(data);
    if (!info) throw new ConnectorError("provider_rejected", "Unexpected response from GitHub");
    return info;
  }
}
