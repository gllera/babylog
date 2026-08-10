// -----------------------------------------------------------------------------
// Request identity for the browser surfaces (/app, /welcome, /api): babylog's
// own session cookie, minted by this Worker after the OIDC code exchange
// against auth.32b.io (src/oidc.ts, src/session.ts).
//
// There used to be two, tried in order, and the first was a Cloudflare Access
// JWT: Access fronted baby.llera.eu, ran the whole OAuth 2.1 flow for MCP
// clients, and stamped `Cf-Access-Jwt-Assertion` on everything it let past.
// /mcp verifies its own access tokens now (src/mcp-auth.ts), which is what let
// that hostname and its Access app be retired — so the header is read by
// nothing and src/access.ts is deleted rather than left dormant. There is no
// precedence question left, and no outer gate for a header to win against.
//
// /mcp does NOT come through here: a bearer token is not a cookie, and its
// refusals carry a `WWW-Authenticate` challenge this function has no way to
// build. See src/mcp-auth.ts.
//
// Dev fallback: DEV_USER_EMAIL (.dev.vars only — never a production var) so
// `wrangler dev` works with no IdP in front.
// -----------------------------------------------------------------------------

import { getSessionEmail } from "./session";
import type { Env } from "./types";

export async function getIdentityEmail(
  request: Request,
  env: Env
): Promise<string | null> {
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
