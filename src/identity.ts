// -----------------------------------------------------------------------------
// Request identity. Two production auth paths during the llera.eu → 32b.io
// transition:
//   1. Cloudflare Access JWT — baby.llera.eu, stamped by the Access app
//      (still fronts MCP and the legacy origin until the OAuth AS lands).
//   2. The 32b.io `sess` cookie — baby.32b.io, minted by the www.32b.io
//      magic-link login (a completed login is email-ownership proof).
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
  if (env.SESSION_SECRET) {
    const email = await getSessionEmail(request, env.SESSION_SECRET);
    if (email) return email;
  }
  if (env.DEV_USER_EMAIL) return env.DEV_USER_EMAIL.toLowerCase();
  return null;
}
