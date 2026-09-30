import { beforeEach } from "vitest";
import { createSafeFetch, PROVIDER_ORIGINS, setTransportOverride } from "@/connectors/transport";
import type { Provider } from "@/connectors/types";

/**
 * Safety net: by default every provider is "unreachable" in tests, so nothing can contact a real
 * service by accident. Tests that need provider behaviour install a fixture explicitly.
 */
const unreachable = (provider: Provider) =>
  createSafeFetch({
    allowedOrigins: PROVIDER_ORIGINS[provider],
    fetchImpl: async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    },
    sleep: async () => {},
  });

beforeEach(() => {
  for (const p of ["github", "slack", "gmail"] as const) setTransportOverride(p, unreachable(p));
});
