export const GITHUB_API = "https://api.github.com";
export const GITHUB_WEB = "https://github.com";
export const GITHUB_API_VERSION = "2022-11-28";

export const githubHeaders = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": GITHUB_API_VERSION,
  "user-agent": "ai-action-inbox",
  ...extra,
});

/** Scope levels offered at connect time. `public_repo` is the least privilege that still creates issues. */
export const GITHUB_SCOPE_LEVELS = {
  public: { scope: "public_repo", label: "Public repositories only" },
  all: { scope: "repo", label: "Public and private repositories" },
} as const;
export type GithubScopeLevel = keyof typeof GITHUB_SCOPE_LEVELS;
export const isScopeLevel = (v: unknown): v is GithubScopeLevel => v === "public" || v === "all";

/** Parses the X-OAuth-Scopes header (comma separated). This is GitHub's own statement of what the token can do. */
export const parseScopeHeader = (v: string | null): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
