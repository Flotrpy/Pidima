import { ConnectorError, type ErrorCategory } from "./errors";
import type { Provider, SafeFetch } from "./types";

/** Fixed API origins per provider. Nothing else is ever contacted with a provider credential. */
export const PROVIDER_ORIGINS: Record<Provider, string[]> = {
  github: ["https://api.github.com", "https://github.com"],
  slack: ["https://slack.com"],
  gmail: [
    "https://gmail.googleapis.com",
    "https://oauth2.googleapis.com",
    "https://www.googleapis.com",
    "https://accounts.google.com",
  ],
};

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 1_000_000;
const MAX_RETRY_WAIT_MS = 5_000;

type Options = {
  allowedOrigins: string[];
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

const NOT_SENT = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function errorCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string; message?: string } };
  // Node blocks some ports outright before any connection is made.
  if (err?.cause?.message === "bad port") return "ENOTFOUND";
  return err?.cause?.code ?? err?.code;
}

/** Parses Retry-After (seconds or HTTP date) or GitHub's x-ratelimit-reset; returns milliseconds. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  const ra = headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const at = Date.parse(ra);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset && headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(Number(reset))) {
    return Math.max(0, Number(reset) * 1000 - now);
  }
  return null;
}

/** Maps an HTTP status to a user-facing category. `write` makes 5xx ambiguous instead of "failed". */
export function categorizeStatus(
  status: number,
  write: boolean,
): { category: ErrorCategory; maybeDispatched: boolean } {
  if (status === 401) return { category: "auth_expired", maybeDispatched: false };
  if (status === 403) return { category: "scope_missing", maybeDispatched: false };
  if (status === 404 || status === 410)
    return { category: "destination_inaccessible", maybeDispatched: false };
  if (status === 429) return { category: "rate_limited", maybeDispatched: false };
  if (status === 408 || status >= 500) {
    return write
      ? { category: "verification_required", maybeDispatched: true }
      : { category: "provider_unavailable", maybeDispatched: false };
  }
  return { category: "provider_rejected", maybeDispatched: false };
}

export function createSafeFetch(opts: Options): SafeFetch {
  const allowed = new Set(opts.allowedOrigins);
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  return async (url, init = {}) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ConnectorError("failed_before_dispatch", "Invalid request URL");
    }
    const secure = parsed.protocol === "https:" || process.env.NODE_ENV === "test";
    if (!secure || !allowed.has(parsed.origin) || parsed.username || parsed.password) {
      // Deliberately does not echo the URL: it may embed identifiers or tokens.
      throw new ConnectorError(
        "failed_before_dispatch",
        "Blocked request to an origin that is not allowed",
      );
    }

    const method = (init.method ?? "GET").toUpperCase();
    const write = !["GET", "HEAD", "OPTIONS"].includes(method);
    const { timeoutMs: perCall, ...rest } = init;
    const timeoutMs = perCall ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxAttempts = write ? 1 : 3;

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(parsed.toString(), {
          ...rest,
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const code = errorCode(e);
        const name = (e as Error)?.name;
        const timedOut = name === "TimeoutError" || name === "AbortError";
        if (code && NOT_SENT.has(code)) {
          throw new ConnectorError("failed_before_dispatch", "Could not connect to the provider");
        }
        if (!write && attempt < maxAttempts) {
          await sleep(200 * attempt);
          continue;
        }
        if (write) {
          // The request may have been received before the connection failed or timed out.
          throw new ConnectorError(
            "verification_required",
            timedOut
              ? "Provider did not respond in time"
              : "Connection to the provider was interrupted",
            true,
          );
        }
        throw new ConnectorError("provider_unavailable", "Provider could not be reached");
      }

      // Never follow redirects: a redirect could carry credentials to another origin.
      if (res.status >= 300 && res.status < 400) {
        throw new ConnectorError("provider_rejected", "Provider returned an unexpected redirect");
      }

      const wait = retryAfterMs(res.headers);
      if (
        (res.status === 429 || res.status === 503) &&
        !write &&
        attempt < maxAttempts &&
        wait !== null &&
        wait <= MAX_RETRY_WAIT_MS
      ) {
        await sleep(wait);
        continue;
      }

      const body = await readBounded(res, maxBytes, write);
      return new Response(
        (res.status === 204 || res.status === 205 ? null : body) as BodyInit | null,
        {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        },
      );
    }
  };
}

async function readBounded(res: Response, maxBytes: number, write: boolean): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw tooLarge(write);
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw tooLarge(write);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof ConnectorError) throw e;
    throw write
      ? new ConnectorError("verification_required", "Provider response was interrupted", true)
      : new ConnectorError("provider_unavailable", "Provider response was interrupted");
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

const tooLarge = (write: boolean) =>
  write
    ? new ConnectorError("verification_required", "Provider response exceeded the size limit", true)
    : new ConnectorError("provider_rejected", "Provider response exceeded the size limit");

export function safeFetchFor(provider: Provider, extra: Partial<Options> = {}): SafeFetch {
  return createSafeFetch({ allowedOrigins: PROVIDER_ORIGINS[provider], ...extra });
}
