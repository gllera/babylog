// -----------------------------------------------------------------------------
// Cloudflare Access JWT verification and identity extraction.
//
// baby.llera.eu is fronted by a Cloudflare Access application with Managed
// OAuth (whole-host: Managed OAuth apps cannot be path-scoped). Access runs
// the whole OAuth 2.1 flow for MCP clients and the normal browser login for
// /app, and only forwards a request once it passes the Access policy,
// stamping it with a `Cf-Access-Jwt-Assertion` header.
//
// We still verify that JWT here: the Worker is also reachable at its
// *.workers.dev origin, which Access does NOT front, so trusting the header
// blindly would leave that origin wide open. Verifying the signature (against
// the team JWKS) plus the issuer/audience guarantees the request really came
// through our Access app — and with multi-user tenancy the JWT's `email`
// claim is load-bearing, not just the pass/fail.
// -----------------------------------------------------------------------------

import { jwtVerify, createRemoteJWKSet } from "jose";
import type { Env } from "./types";

// createRemoteJWKSet caches the fetched keys (with its own refresh cooldown),
// so keep one instance per isolate keyed by the team domain.
let jwksFor: { domain: string; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

export type AccessPayload = {
  email?: string;
  [claim: string]: unknown;
};

export async function verifyAccessJwt(
  token: string,
  env: Env
): Promise<AccessPayload | null> {
  if (jwksFor?.domain !== env.TEAM_DOMAIN) {
    jwksFor = {
      domain: env.TEAM_DOMAIN,
      jwks: createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`)),
    };
  }
  try {
    const { payload } = await jwtVerify(token, jwksFor.jwks, {
      issuer: env.TEAM_DOMAIN,
      audience: env.POLICY_AUD,
      // Cloudflare Access signs its assertions with RS256; pin it so a token
      // can't downgrade the verification (defence-in-depth on top of the
      // asymmetric JWKS, which already rejects `alg:none`/HS confusion).
      algorithms: ["RS256"],
    });
    return payload as AccessPayload;
  } catch {
    return null;
  }
}

// The identity (lowercased email) behind a request, or null when
// unauthenticated. Dev fallback: with no valid Access JWT, `DEV_USER_EMAIL`
// (.dev.vars only — never a production var) supplies the identity so
// `wrangler dev` works without Access in front.
export async function getAccessEmail(
  request: Request,
  env: Env
): Promise<string | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (token) {
    const payload = await verifyAccessJwt(token, env);
    if (typeof payload?.email === "string" && payload.email) {
      return payload.email.toLowerCase();
    }
  }
  if (env.DEV_USER_EMAIL) return env.DEV_USER_EMAIL.toLowerCase();
  return null;
}
