import type { Authenticator } from "./http";

/**
 * Bearer-token verification lands in P1-024. Until then no token can be valid, so the endpoint
 * fails closed and answers 401 to every request.
 */
export const authenticateBearer: Authenticator = async () => null;
