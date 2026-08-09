// -----------------------------------------------------------------------------
// Alexa account linking: the mini authorization server babylog fronts for
// exactly one client — Amazon.
//
// Why this exists at all: auth.32b.io's access tokens live 10 minutes and it
// issues no refresh tokens, while Alexa stores a token at link time and
// replays it for months. So babylog runs the OIDC login it already has
// (src/oidc.ts) to establish WHO, then wraps that identity in tokens it can
// verify locally — the same move as __Host-bsess, for a channel the IdP
// cannot serve. Identity never originates here.
//
// The HMAC secret is ALEXA_OAUTH_HMAC_SECRET, deliberately distinct from
// SESSION_HMAC_SECRET: rotating web sessions must never unlink every Echo,
// and unlinking Alexa must never sign the web out. The typ header is the
// wall between token kinds and is pinned on every verify.
// -----------------------------------------------------------------------------

import { SignJWT, jwtVerify } from "jose";
import type { Env } from "./types";

const ISSUER = "https://baby.32b.io";

export const CODE_TYP = "alexacode+jwt";
export const ACCESS_TYP = "alexatk+jwt";
export const REFRESH_TYP = "alexart+jwt";

export type LinkTyp = typeof CODE_TYP | typeof ACCESS_TYP | typeof REFRESH_TYP;

export const CODE_TTL_S = 60;
export const ACCESS_TTL_S = 24 * 60 * 60;
// Amazon re-links only when refresh fails; make that a rare event.
export const REFRESH_TTL_S = 400 * 24 * 60 * 60;

export type LinkClaims = {
  sub: string;
  email: string;
  redirect_uri?: string;
  jti?: string;
};

const keyOf = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export async function mintLinkToken(
  env: Pick<Env, "ALEXA_OAUTH_HMAC_SECRET">,
  typ: LinkTyp,
  id: { sub: string; email: string },
  ttlSeconds: number,
  extra: Record<string, string> = {}
): Promise<string> {
  return new SignJWT({ email: id.email, ...extra })
    .setProtectedHeader({ alg: "HS256", typ })
    .setSubject(id.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(keyOf(env.ALEXA_OAUTH_HMAC_SECRET!));
}

export async function verifyLinkToken(
  env: Pick<Env, "ALEXA_OAUTH_HMAC_SECRET">,
  token: string,
  typ: LinkTyp
): Promise<LinkClaims | null> {
  if (!env.ALEXA_OAUTH_HMAC_SECRET) {
    console.log("ALEXA_OAUTH_HMAC_SECRET is not set — no Alexa link token can be verified");
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, keyOf(env.ALEXA_OAUTH_HMAC_SECRET), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      typ,
      requiredClaims: ["iss", "iat", "exp", "sub"],
    });
    if (typeof payload.email !== "string" || !payload.email) return null;
    return {
      sub: String(payload.sub),
      email: payload.email.toLowerCase(),
      redirect_uri:
        typeof payload.redirect_uri === "string" ? payload.redirect_uri : undefined,
      jti: typeof payload.jti === "string" ? payload.jti : undefined,
    };
  } catch {
    return null;
  }
}
