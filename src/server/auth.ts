/**
 * Optional API-token authentication for Squawkie-Talkie.
 *
 * The token is an *alternative* credential for machine clients, not a mandatory
 * gate — the real authentication boundary is enforced upstream (Authelia / the
 * reverse proxy). Enforcement is therefore ADDITIVE: the token is validated
 * only when an `Authorization` header is present. Requests with no such header
 * (the browser UI and internal-LAN clients, which arrive via the session/proxy
 * path and legitimately carry no bearer token) pass through unchanged. This is
 * load-bearing — native `EventSource` cannot set request headers, so a
 * mandatory token on `/api/stream` would break the realtime feed.
 *
 * The feature is OFF unless a token is configured, so running with no token env
 * set behaves exactly as before (full backward compatibility).
 *
 *   SQUAWK_API_TOKEN        the token, as a literal env value.
 *   SQUAWK_API_TOKEN_FILE   path to a file holding the token (Docker/Swarm
 *                           secret); wins over SQUAWK_API_TOKEN if both are set.
 *                           Trailing whitespace/newline is trimmed.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

/** A minimal, test-injectable view of the process environment. */
type Env = Record<string, string | undefined>;

/**
 * Resolve the configured API token, or null when the feature is off.
 *
 * `SQUAWK_API_TOKEN_FILE` takes precedence over `SQUAWK_API_TOKEN`. The value is
 * trimmed; an empty, unset, or unreadable source yields null. Resolved fresh on
 * every call (no cache) so tests can vary the env and the operator can rotate
 * the secret file without restarting the process.
 */
export function resolveApiToken(env: Env = process.env): string | null {
  const file = env.SQUAWK_API_TOKEN_FILE;
  if (file) {
    try {
      return readFileSync(file, "utf8").trim() || null;
    } catch {
      // Unreadable secret file → treat as unconfigured rather than crash.
      return null;
    }
  }
  const inline = env.SQUAWK_API_TOKEN?.trim();
  return inline ? inline : null;
}

/**
 * Constant-time string equality via fixed-length SHA-256 digests. Hashing both
 * sides to 32 bytes means `timingSafeEqual` never throws on a length mismatch
 * and no length information leaks through the comparison.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Extract the token from a `Bearer <token>` Authorization header, or null. */
function bearerToken(header: string): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * Authorize an API request. Returns null to allow it through, or a 401 Response
 * to reject it.
 *
 *   - No token configured        → allow (feature off).
 *   - No `Authorization` header   → allow (proxy/session path; the browser UI
 *                                   depends on this, and `EventSource` cannot
 *                                   send the header).
 *   - `Authorization` present     → must be a `Bearer` token matching the
 *                                   configured one (constant-time). Anything
 *                                   else — wrong token, or a malformed/non-Bearer
 *                                   header — is a 401.
 */
export function checkApiToken(req: Request): Response | null {
  const configured = resolveApiToken();
  if (!configured) {
    return null;
  }
  const header = req.headers.get("authorization");
  if (header === null) {
    return null;
  }
  const presented = bearerToken(header);
  if (presented !== null && constantTimeEqual(presented, configured)) {
    return null;
  }
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
