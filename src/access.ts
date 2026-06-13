// -----------------------------------------------------------------------------
// Cloudflare Access JWT verification for the /mcp endpoint.
//
// /mcp is protected by a Cloudflare Access application with Managed OAuth:
// Access runs the whole OAuth 2.1 flow for the MCP client (discovery, dynamic
// client registration, login against the configured identity provider) and
// only forwards a request to this Worker once it passes the Access policy,
// stamping it with a `Cf-Access-Jwt-Assertion` header.
//
// We still verify that JWT here: the Worker is also reachable at its
// *.workers.dev origin, which Access does NOT front, so trusting the header
// blindly would leave that origin wide open. Verifying the signature (against
// the team JWKS) plus the issuer/audience guarantees the request really came
// through our Access app.
// -----------------------------------------------------------------------------

import { jwtVerify, createRemoteJWKSet } from "jose";
import type { Env } from "./types";

// createRemoteJWKSet caches the fetched keys (with its own refresh cooldown),
// so keep one instance per isolate keyed by the team domain.
let jwksFor: { domain: string; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

export async function verifyAccessJwt(token: string, env: Env): Promise<boolean> {
  if (jwksFor?.domain !== env.TEAM_DOMAIN) {
    jwksFor = {
      domain: env.TEAM_DOMAIN,
      jwks: createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`)),
    };
  }
  try {
    await jwtVerify(token, jwksFor.jwks, {
      issuer: env.TEAM_DOMAIN,
      audience: env.POLICY_AUD,
    });
    return true;
  } catch {
    return false;
  }
}
