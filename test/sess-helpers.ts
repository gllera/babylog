// Session-cookie minting for the tests, in both formats.
//
// Not a .test.ts file, so vitest does not collect it as a suite (same as
// app-inline.ts). Shared because two suites need it: session.test.ts checks the
// verifier directly and identity.test.ts checks it through the identity
// precedence rules, and both have to be able to present the same cookies.

import { SignJWT, exportJWK, generateKeyPair } from "jose";

export const ISS = "https://auth.32b.io";

export async function keys() {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  return { privateKey, pub: JSON.stringify(await exportJWK(publicKey)) };
}

// Mints exactly what auth.32b.io mints, so the assertions are about the wire
// format rather than about a helper the two repos share — they share none.
export const mintSess = (
  privateKey: Awaited<ReturnType<typeof keys>>["privateKey"],
  claims: Record<string, unknown>,
  iss = ISS
): Promise<string> =>
  new SignJWT({ t: "sess", ...claims })
    .setProtectedHeader({ alg: "EdDSA", typ: "sess+jwt" })
    .setIssuer(iss)
    .setIssuedAt()
    .sign(privateKey);

// The format www.32b.io used to mint before auth.32b.io existed:
// b64u(JSON payload) "." b64u(HMAC-SHA256(secret, body)), payload
// `{t:'sess', e:<email>, x?:<expiry ms>}`.
//
// The production code that could build one of these is gone — deliberately, along
// with SESSION_SECRET — and this exists only so the tests can present a *validly
// signed* legacy cookie and watch it be refused. A forgery would prove nothing:
// the signature check would reject it whether the branch existed or not. The proof
// has to outlive the code it disproves.
export async function mintLegacy(secret: string, payload: object): Promise<string> {
  const enc = new TextEncoder();
  const b64u = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${b64u(sig)}`;
}

export const cookieReq = (token: string, url = "https://baby.32b.io/"): Request =>
  new Request(url, { headers: { Cookie: `sess=${token}` } });
