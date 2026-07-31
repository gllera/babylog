// -----------------------------------------------------------------------------
// 32b.io session verification.
//
// auth.32b.io mints Ed25519 JWTs (`typ: sess+jwt`, `t: "sess"`) carrying `sub` —
// the account id — with the email as a display claim. That is the only format
// this Worker reads, and the cookie is scoped Domain=32b.io, so baby.32b.io
// receives it from a login that happened anywhere on the estate.
//
// www.32b.io used to mint HMAC-SHA256 tokens (`b64u(payload).b64u(sig)`, payload
// `{t:'sess', e:<email>, x?:<expiry ms>}`) and those were accepted here through
// the cutover so it signed nobody out. That branch is gone, along with
// makeToken/readToken and `SESSION_SECRET`: www serves no login and mints no
// token any more, so the fallback protected nothing and the shared secret was a
// forging key with no remaining purpose. Anyone still carrying a legacy cookie is
// signed out and logs in again at auth.32b.io.
//
// test/session.test.ts keeps a local HMAC minter for one reason: to present a
// validly signed legacy cookie and assert it is refused *even when
// SESSION_SECRET is still in the environment*. The proof has to outlive the code
// it disproves.
// -----------------------------------------------------------------------------

import { importJWK, jwtVerify, type CryptoKey, type JWK } from "jose";
import type { Env } from "./types";

export function getSessionToken(cookieHeader: string | null): string | null {
  const m = (cookieHeader || "").match(/(?:^|;\s*)sess=([^;]+)/);
  return m ? m[1] : null;
}

// `sub` is never null now. It was, for legacy cookies, which carried an email and
// no account id; with that format gone every session has the account behind it —
// which is what tenancy will key on when it moves off email (phase 2).
export type Identity = { sub: string; email: string };

// Imports are a pure function of the JWK text, so caching by that text saves an
// import per gated request in a warm isolate. A rejection is evicted so a fixed
// var can recover without a redeploy.
const keyCache = new Map<string, Promise<CryptoKey>>();
const pubKey = (json: string): Promise<CryptoKey> => {
  let hit = keyCache.get(json);
  if (!hit) {
    hit = importJWK(JSON.parse(json) as JWK, "EdDSA")
      .then((k) => k as CryptoKey)
      .catch((e) => {
        keyCache.delete(json);
        throw e;
      });
    keyCache.set(json, hit);
  }
  return hit;
};

// The identity behind the request's sess cookie, or null. Never throws.
//
// Tenancy still keys on email; re-keying it onto `sub` is phase 2, and `sub` is
// carried here so that work has something to key on.
export async function getSessionIdentity(
  request: Request,
  env: Pick<Env, "SESSION_PUBLIC_JWK" | "ISSUER">
): Promise<Identity | null> {
  const token = getSessionToken(request.headers.get("Cookie"));
  if (!token) return null;

  if (!env.SESSION_PUBLIC_JWK) {
    // There is no second format behind this any more, so an unset var is not a
    // degraded mode: it refuses every session on the Worker. Name it, or the
    // symptom reads as an estate-wide sign-out with no cause.
    console.log("SESSION_PUBLIC_JWK is not set — no session cookie can be verified");
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, await pubKey(env.SESSION_PUBLIC_JWK), {
      algorithms: ["EdDSA"],
      issuer: env.ISSUER ?? "https://auth.32b.io",
      typ: "sess+jwt",
      // `sub` is required: a session cookie with no account id behind it is
      // not something this Worker should act on.
      requiredClaims: ["iss", "iat", "sub"],
    });
    if (payload.t === "sess" && typeof payload.email === "string" && payload.email) {
      return { sub: String(payload.sub), email: payload.email.toLowerCase() };
    }
  } catch {
    /* an unverifiable cookie is simply not a session */
  }
  return null;
}

// The lowercased email behind the request's sess cookie, or null. A wrapper, so
// that callers which do not care about the account id did not all have to change
// when the second format arrived.
export async function getSessionEmail(
  request: Request,
  env: Pick<Env, "SESSION_PUBLIC_JWK" | "ISSUER">
): Promise<string | null> {
  return (await getSessionIdentity(request, env))?.email ?? null;
}
