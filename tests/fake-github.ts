import { createSafeFetch } from "@/connectors/transport";
import type { SafeFetch } from "@/connectors/types";

export type FakeRepo = {
  owner: string;
  name: string;
  private?: boolean;
  archived?: boolean;
  has_issues?: boolean;
  disabled?: boolean;
};

export type FakeGithubOptions = {
  token?: string;
  user?: { id: number; login: string };
  scopes?: string;
  repos?: FakeRepo[];
  /** Force a status for a path prefix, e.g. { "/repos/acme/x/issues": 503 }. */
  failures?: Record<string, number>;
  /** Simulate GitHub processing the write but the response being lost. */
  dropIssueResponse?: boolean;
  hang?: boolean;
};

/**
 * A stateful stand-in for the parts of GitHub we use. It enforces auth and records every request,
 * so tests can assert exactly what was (and was not) sent. This is a fixture, not a live provider.
 */
export function fakeGithub(opts: FakeGithubOptions = {}) {
  const token = opts.token ?? "gho_test_token_123";
  const user = opts.user ?? { id: 583231, login: "octocat" };
  const repos = opts.repos ?? [{ owner: "acme", name: "platform" }];
  const requests: { method: string; path: string; body?: unknown; headers: Headers }[] = [];
  const issues: {
    number: number;
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels: string[];
    idempotency?: string | null;
  }[] = [];

  const raw = (r: FakeRepo) => ({
    full_name: `${r.owner}/${r.name}`,
    name: r.name,
    owner: { login: r.owner },
    private: !!r.private,
    archived: !!r.archived,
    disabled: !!r.disabled,
    has_issues: r.has_issues ?? true,
    permissions: { pull: true, push: true },
  });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    requests.push({ method, path: url.pathname + url.search, body, headers });
    if (opts.hang) await new Promise((r) => setTimeout(r, 5000));

    for (const [prefix, status] of Object.entries(opts.failures ?? {})) {
      if (url.pathname.startsWith(prefix))
        return new Response(JSON.stringify({ message: "forced failure" }), { status });
    }
    const json = (o: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(o), {
        status,
        headers: { "content-type": "application/json", ...extra },
      });

    if (url.pathname === "/zen") return new Response("Keep it logically awesome.");
    if (headers.get("authorization") !== `Bearer ${token}`)
      return json({ message: "Bad credentials" }, 401);

    if (url.pathname === "/user")
      return json(user, 200, { "x-oauth-scopes": opts.scopes ?? "repo" });
    if (url.pathname === "/user/repos") {
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const slice = repos.slice((page - 1) * per, page * per);
      return json(
        slice.map(raw),
        200,
        repos.length > page * per
          ? { link: '<https://api.github.com/user/repos?page=2>; rel="next"' }
          : {},
      );
    }
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (repoMatch && method === "GET") {
      const r = repos.find(
        (x) =>
          x.owner.toLowerCase() === repoMatch[1]!.toLowerCase() &&
          x.name.toLowerCase() === repoMatch[2]!.toLowerCase(),
      );
      return r ? json(raw(r)) : json({ message: "Not Found" }, 404);
    }
    const issueMatch = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(url.pathname);
    if (issueMatch && method === "POST") {
      const r = repos.find(
        (x) =>
          x.owner.toLowerCase() === issueMatch[1]!.toLowerCase() &&
          x.name.toLowerCase() === issueMatch[2]!.toLowerCase(),
      );
      if (!r) return json({ message: "Not Found" }, 404);
      const b = body as { title: string; body?: string; labels?: string[] };
      if (!b.title) return json({ message: "Validation Failed" }, 422);
      const issue = {
        number: issues.length + 1,
        owner: r.owner,
        repo: r.name,
        title: b.title,
        body: b.body ?? "",
        labels: b.labels ?? [],
        idempotency: headers.get("x-idempotency-key"),
      };
      issues.push(issue);
      if (opts.dropIssueResponse)
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      return json(
        {
          id: 900000 + issue.number,
          number: issue.number,
          html_url: `https://github.com/${r.owner}/${r.name}/issues/${issue.number}`,
          title: issue.title,
        },
        201,
      );
    }
    return json({ message: "Not Found" }, 404);
  };

  const sf: SafeFetch = createSafeFetch({
    allowedOrigins: ["https://api.github.com", "https://github.com"],
    fetchImpl,
    sleep: async () => {},
  });
  return { sf, fetchImpl, requests, issues, token };
}
