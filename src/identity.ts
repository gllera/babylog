// -----------------------------------------------------------------------------
// Request identity. Two production auth paths, on two hostnames:
//   1. Cloudflare Access JWT — baby.llera.eu, stamped by the Access app, which
//      still fronts /mcp and the legacy origin.
//   2. babylog's own session cookie — baby.32b.io. Minted by this Worker after
//      the OIDC code exchange against auth.32b.io (src/oidc.ts), replacing the
//      estate-wide `sess` cookie this file used to read.
//
// The order matters and did not change: Access is the outer gate on the host it
// fronts, so its assertion wins where it exists.
//
// Dev fallback: DEV_USER_EMAIL (.dev.vars only — never a production var) so
// `wrangler dev` works with neither in front.
// -----------------------------------------------------------------------------

import { verifyAccessJwt } from "./access";
import { getSessionEmail } from "./session";
import type { Env } from "./types";

export async function getIdentityEmail(
  request: Request,
  env: Env
): Promise<string | null> {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) {
    const payload = await verifyAccessJwt(jwt, env);
    if (typeof payload?.email === "string" && payload.email) {
      return payload.email.toLowerCase();
    }
  }
  // getSessionEmail answers null when the secret is unconfigured, so there is
  // nothing to guard on here.
  const email = await getSessionEmail(request, env);
  if (email) return email;
  // Dev fallback only answers on wrangler dev's local origin — a stray
  // DEV_USER_EMAIL in production must never authenticate anybody.
  if (env.DEV_USER_EMAIL) {
    const host = new URL(request.url).hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return env.DEV_USER_EMAIL.toLowerCase();
    }
  }
  return null;
}
