// -----------------------------------------------------------------------------
// babylog's own session cookie.
//
// Until 2026-08-01 this file verified auth.32b.io's estate-wide `sess` cookie:
// Ed25519, `typ: sess+jwt`, scoped Domain=32b.io so one login covered every
// subdomain. babylog is an OIDC client now (src/oidc.ts) — it exchanges an
// authorization code once and mints the session below — and that verifier is
// gone rather than kept alongside.
//
// Deleting it is the entire point, not a tidy-up. auth.32b.io cannot move its
// session cookie to a `__Host-` prefix while any estate product still reads the
// Domain=32b.io one, and that prefix is what closes the planted-cookie fixation
// hole: today any 32b.io host can set a `sess` cookie that sorts ahead of the
// real one. babylog was one of three holdouts. test/session.test.ts pins the
// shared cookie buying nothing here, so the dependency cannot be reopened by
// accident.
//
// The secret is a per-Worker HMAC key, which is a different animal from the
// estate-wide `SESSION_SECRET` this repo retired in the cutover: that one was
// shared with www.32b.io and could forge a session for anybody, anywhere on
// 32b.io. This one forges baby.32b.io sessions and nothing else, and the cookie
// it signs is `__Host-` so no sibling host can even deliver a forgery here.
//
// It is named SESSION_HMAC_SECRET and not SESSION_SECRET precisely so those two
// cannot be confused. The old name means "an estate-wide forging key that should
// no longer exist anywhere", and reusing it for an ordinary per-Worker key would
// make that alarm useless in both directions.
// -----------------------------------------------------------------------------

import { SignJWT, jwtVerify } from "jose";
import type { Env } from "./types";

// `__Host-` forbids Domain and pins Path=/, so the browser will only ever send
// this to the exact host that set it. That is the property; the name is just a
// name, chosen distinct from `sess` so that a cookie jar carrying both during
// the estate's transition is unambiguous in a log.
export const SESSION_COOKIE = "__Host-bsess";

// Who signed it. Checked on the way in, because one HMAC key is only a boundary
// if the issuer is checked too.
const ISSUER = "https://baby.32b.io";

// Matches the IdP's own session length. A client is entitled to its own answer
// here — nothing re-checks with auth.32b.io until this expires, which is exactly
// what "confidential client, does not talk to the IdP again" means — so the
// number is a deliberate statement about how long a stale sign-out can last.
const MAX_AGE_S = 30 * 24 * 60 * 60;

export type Identity = { sub: string; email: string };

const keyOf = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export async function mintSession(
  env: Pick<Env, "SESSION_HMAC_SECRET">,
  { sub, email }: Identity
): Promise<string> {
  return new SignJWT({ t: "sess", sub, email })
    .setProtectedHeader({ alg: "HS256", typ: "bsess+jwt" })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_S}s`)
    .sign(keyOf(env.SESSION_HMAC_SECRET!));
}

export const sessionCookie = (token: string): string =>
  `${SESSION_COOKIE}=${token}; Max-Age=${MAX_AGE_S}; Path=/; HttpOnly; Secure; SameSite=Lax`;

export const clearSessionCookie = (): string =>
  `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

// Only ONE candidate is read, unlike the estate verifier this replaced. That
// function tried every `sess` cookie because a host-only plant sorts ahead of
// the Domain one and reading the first was a lockout; `__Host-` means no other
// host can write this name at all, so there is no second candidate to defend
// against and no reason to spend an HMAC verify per copy.
const cookieValue = (header: string | null, name: string): string | null => {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
};

// The identity behind the request's session cookie, or null. Never throws.
export async function readSession(
  request: Request,
  env: Pick<Env, "SESSION_HMAC_SECRET">
): Promise<Identity | null> {
  const token = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!token) return null;

  if (!env.SESSION_HMAC_SECRET) {
    // Nothing is behind this: an unset secret refuses every session on the
    // Worker. Name it, or the symptom reads as a mysterious sign-out.
    console.log("SESSION_HMAC_SECRET is not set — no session cookie can be verified");
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, keyOf(env.SESSION_HMAC_SECRET), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      typ: "bsess+jwt",
      requiredClaims: ["iss", "iat", "exp", "sub"],
    });
    if (payload.t === "sess" && typeof payload.email === "string" && payload.email) {
      return { sub: String(payload.sub), email: payload.email.toLowerCase() };
    }
  } catch {
    /* an unverifiable cookie is simply not a session */
  }
  return null;
}

// The lowercased email behind the request's session cookie, or null. A wrapper,
// kept because most callers only ever wanted the email.
export async function getSessionEmail(
  request: Request,
  env: Pick<Env, "SESSION_HMAC_SECRET">
): Promise<string | null> {
  return (await readSession(request, env))?.email ?? null;
}
