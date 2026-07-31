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

// EVERY `sess` cookie the browser sent, not just the first.
//
// The cookie is Domain=32b.io so one login covers every subdomain, and the cost of
// that scope is that any estate host can set one — and a host-only cookie planted
// by another host sorts AHEAD of the real one on specificity. Reading only the
// first (which this did) lets that host decide which cookie is even considered, so
// a junk plant became a lockout. It is also the likelier accident: a stale
// host-only cookie sitting beside the Domain one.
//
// What trying all of them does NOT buy, so nobody budgets for it: a plant that
// verifies is a session by every check available here, and it wins if it sorts
// first. Only `sess` becoming a `__Host-` cookie no other host may write closes
// that — stage 3 of 32b-auth's roadmap, which is deliberate about not pretending
// anything earlier fixes it.
//
// Same shape as getSessionTokens in 32b-auth's consumer/session.js, which is the
// reference for this rule.
export function getSessionTokens(cookieHeader: string | null): string[] {
  const out: string[] = [];
  for (const part of (cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === "sess") out.push(part.slice(eq + 1).trim());
  }
  return out;
}

// Trying a few DISTINCT candidates is what stops a plant from shadowing the real
// session; stopping at a few is what stops a hand-built header from buying an
// Ed25519 verify per copy.
const MAX_CANDIDATES = 3;

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
  const tokens = [...new Set(getSessionTokens(request.headers.get("Cookie")))].slice(
    0,
    MAX_CANDIDATES
  );
  if (tokens.length === 0) return null;

  if (!env.SESSION_PUBLIC_JWK) {
    // There is no second format behind this any more, so an unset var is not a
    // degraded mode: it refuses every session on the Worker. Name it, or the
    // symptom reads as an estate-wide sign-out with no cause.
    console.log("SESSION_PUBLIC_JWK is not set — no session cookie can be verified");
    return null;
  }

  // First candidate that verifies wins. A cookie that does not verify is skipped
  // rather than fatal, which is the whole point of reading more than one.
  for (const token of tokens) {
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
      /* an unverifiable cookie is simply not a session — try the next one */
    }
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
