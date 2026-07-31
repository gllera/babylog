// -----------------------------------------------------------------------------
// 32b.io session verification, in two formats.
//
// auth.32b.io mints Ed25519 JWTs (`typ: sess+jwt`, `t: "sess"`) carrying `sub` —
// the account id — with the email as a display claim. That is the format to
// build on.
//
// www.32b.io used to mint HMAC-SHA256 tokens `b64u(JSON payload) + "." +
// b64u(signature)` with payload { t: 'sess', e: <email>, x?: <expiry ms> }.
// Those are still accepted so the cutover to auth.32b.io signs nobody out. This
// Worker cannot re-mint one in the new format — minting needs the private key,
// which only 32b-auth holds — so a legacy cookie simply keeps working until its
// owner next signs in. Delete the branch, and SESSION_SECRET, once nobody is
// still carrying one; see docs/cutover-phase1.md in gllera/32b-auth.
//
// Both formats arrive in the same `sess` cookie, scoped Domain=32b.io, so
// baby.32b.io receives whichever one the browser holds on every request.
// -----------------------------------------------------------------------------

import { importJWK, jwtVerify, type CryptoKey, type JWK } from "jose";
import type { Env } from "./types";

const enc = new TextEncoder();

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const unb64u = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0)
  );

// usages is string[] because @cloudflare/workers-types types importKey that
// way (KeyUsage is a DOM lib type and "dom" isn't in this repo's tsconfig).
const hmacKey = (secret: string, usages: string[]) =>
  crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );

// `e` is optional: readToken returns any validly-signed payload of the right
// type — only getSessionEmail guarantees a usable email. NOTE: a token STRING
// is not canonical (extra dot segments / base64 padding verify identically);
// never key anything (e.g. future revocation) on token-string equality.
export type SessPayload = { t: string; e?: string; x?: number };

export async function makeToken(
  secret: string,
  payload: SessPayload
): Promise<string> {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret, ["sign"]);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(body))
  );
  return `${body}.${b64u(sig)}`;
}

// The payload if the signature verifies, `t` matches and `x` (when present)
// is still in the future; else null.
export async function readToken(
  secret: string,
  token: string,
  type: string
): Promise<SessPayload | null> {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  try {
    const key = await hmacKey(secret, ["verify"]);
    if (!(await crypto.subtle.verify("HMAC", key, unb64u(sig), enc.encode(body)))) {
      return null;
    }
    const payload = JSON.parse(
      new TextDecoder().decode(unb64u(body))
    ) as SessPayload;
    if (payload.t !== type) return null;
    if (payload.x !== undefined && (typeof payload.x !== "number" || payload.x < Date.now())) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function getSessionToken(cookieHeader: string | null): string | null {
  const m = (cookieHeader || "").match(/(?:^|;\s*)sess=([^;]+)/);
  return m ? m[1] : null;
}

export type Identity = { sub: string | null; email: string };

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
// `sub` is the account id, and is null for a legacy cookie — callers must
// tolerate that until the legacy branch is gone. Tenancy still keys on email;
// re-keying it onto `sub` is phase 2.
export async function getSessionIdentity(
  request: Request,
  env: Pick<Env, "SESSION_PUBLIC_JWK" | "SESSION_SECRET" | "ISSUER">
): Promise<Identity | null> {
  const token = getSessionToken(request.headers.get("Cookie"));
  if (!token) return null;

  if (env.SESSION_PUBLIC_JWK) {
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
      /* fall through to the legacy branch */
    }
  }

  if (env.SESSION_SECRET) {
    const p = await readToken(env.SESSION_SECRET, token, "sess");
    if (typeof p?.e === "string" && p.e) return { sub: null, email: p.e.toLowerCase() };
  }
  return null;
}

// The lowercased email behind the request's sess cookie, or null. A wrapper, so
// that callers which do not care about the account id did not all have to change
// when the second format arrived.
export async function getSessionEmail(
  request: Request,
  env: Pick<Env, "SESSION_PUBLIC_JWK" | "SESSION_SECRET" | "ISSUER">
): Promise<string | null> {
  return (await getSessionIdentity(request, env))?.email ?? null;
}
