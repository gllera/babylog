import { describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  makeToken,
  readToken,
  getSessionToken,
  getSessionEmail,
  getSessionIdentity,
} from "../src/session";
import type { Env } from "../src/types";

const SECRET = "test-secret";
const ISS = "https://auth.32b.io";

const legacyEnv = { SESSION_SECRET: SECRET } as Env;

describe("session token codec", () => {
  it("round-trips a valid sess token", async () => {
    const tok = await makeToken(SECRET, { t: "sess", e: "Ana@Example.com" });
    const payload = await readToken(SECRET, tok, "sess");
    expect(payload).toEqual({ t: "sess", e: "Ana@Example.com" });
  });

  it("rejects a tampered signature", async () => {
    const tok = await makeToken(SECRET, { t: "sess", e: "a@b.c" });
    const [body] = tok.split(".");
    const other = await makeToken("other-secret", { t: "sess", e: "a@b.c" });
    const forged = `${body}.${other.split(".")[1]}`;
    expect(await readToken(SECRET, forged, "sess")).toBeNull();
  });

  it("rejects the wrong token type", async () => {
    const tok = await makeToken(SECRET, { t: "login", e: "a@b.c" });
    expect(await readToken(SECRET, tok, "sess")).toBeNull();
  });

  it("rejects an expired token and accepts a future expiry", async () => {
    const dead = await makeToken(SECRET, { t: "sess", e: "a@b.c", x: Date.now() - 1000 });
    expect(await readToken(SECRET, dead, "sess")).toBeNull();
    const live = await makeToken(SECRET, { t: "sess", e: "a@b.c", x: Date.now() + 60_000 });
    expect(await readToken(SECRET, live, "sess")).toEqual({ t: "sess", e: "a@b.c", x: expect.any(Number) });
  });

  it("returns null on malformed tokens", async () => {
    expect(await readToken(SECRET, "", "sess")).toBeNull();
    expect(await readToken(SECRET, "no-dot", "sess")).toBeNull();
    expect(await readToken(SECRET, "!!.!!", "sess")).toBeNull();
  });

  it("extracts the sess cookie among other cookies", () => {
    expect(getSessionToken("a=1; sess=tok.sig; b=2")).toBe("tok.sig");
    expect(getSessionToken("sess=solo")).toBe("solo");
    expect(getSessionToken("nosess=1")).toBeNull();
    expect(getSessionToken(null)).toBeNull();
  });

  it("getSessionEmail reads the request cookie and lowercases", async () => {
    const tok = await makeToken(SECRET, { t: "sess", e: "Ana@Example.com" });
    const req = new Request("https://baby.32b.io/app", {
      headers: { Cookie: `sess=${tok}` },
    });
    expect(await getSessionEmail(req, legacyEnv)).toBe("ana@example.com");
    expect(await getSessionEmail(new Request("https://baby.32b.io/app"), legacyEnv)).toBeNull();
  });

  it("getSessionEmail returns null for a validly-signed token with no email", async () => {
    const tok = await makeToken(SECRET, { t: "sess" });
    const req = new Request("https://baby.32b.io/app", {
      headers: { Cookie: `sess=${tok}` },
    });
    expect(await getSessionEmail(req, legacyEnv)).toBeNull();
  });

  it("rejects a token whose body was swapped for another payload", async () => {
    const tok = await makeToken(SECRET, { t: "sess", e: "a@b.c" });
    const [, sig] = tok.split(".");
    const other = await makeToken(SECRET, { t: "sess", e: "other@example.com" });
    const [otherBody] = other.split(".");
    const forged = `${otherBody}.${sig}`;
    expect(await readToken(SECRET, forged, "sess")).toBeNull();
  });
});

async function keys() {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  return { privateKey, pub: JSON.stringify(await exportJWK(publicKey)) };
}

const req = (token: string) =>
  new Request("https://baby.32b.io/", { headers: { Cookie: `sess=${token}` } });

// Mints exactly what auth.32b.io mints, so these assertions are about the wire
// format rather than about a helper the two repos share — they share none.
const mintSess = (
  privateKey: Awaited<ReturnType<typeof keys>>["privateKey"],
  claims: Record<string, unknown>,
  iss = ISS
) =>
  new SignJWT({ t: "sess", ...claims })
    .setProtectedHeader({ alg: "EdDSA", typ: "sess+jwt" })
    .setIssuer(iss)
    .setIssuedAt()
    .sign(privateKey);

describe("getSessionIdentity", () => {
  it("reads an Ed25519 cookie from auth.32b.io", async () => {
    const { privateKey, pub } = await keys();
    const t = await mintSess(privateKey, { sub: "u_1", email: "A@B.com" });
    const env = { SESSION_PUBLIC_JWK: pub, ISSUER: ISS } as Env;
    expect(await getSessionIdentity(req(t), env)).toEqual({ sub: "u_1", email: "a@b.com" });
  });

  it("still reads a legacy HMAC cookie, with no sub", async () => {
    const t = await makeToken(SECRET, { t: "sess", e: "a@b.com" });
    expect(await getSessionIdentity(req(t), legacyEnv)).toEqual({ sub: null, email: "a@b.com" });
  });

  it("refuses a legacy cookie once SESSION_SECRET is gone", async () => {
    const { pub } = await keys();
    const t = await makeToken(SECRET, { t: "sess", e: "a@b.com" });
    const env = { SESSION_PUBLIC_JWK: pub, ISSUER: ISS } as Env;
    expect(await getSessionIdentity(req(t), env)).toBeNull();
  });

  it("refuses an Ed25519 cookie from another issuer", async () => {
    const { privateKey, pub } = await keys();
    const t = await mintSess(privateKey, { sub: "u_1", email: "a@b.com" }, "https://evil.example");
    const env = { SESSION_PUBLIC_JWK: pub, ISSUER: ISS } as Env;
    expect(await getSessionIdentity(req(t), env)).toBeNull();
  });

  it("refuses an Ed25519 cookie signed by another key", async () => {
    const mine = await keys();
    const theirs = await keys();
    const t = await mintSess(theirs.privateKey, { sub: "u_1", email: "a@b.com" });
    const env = { SESSION_PUBLIC_JWK: mine.pub, ISSUER: ISS } as Env;
    expect(await getSessionIdentity(req(t), env)).toBeNull();
  });

  // The type check is the only thing between a magic link and a session cookie,
  // and both are signed by the same key.
  it("refuses a magic-link token presented as a session", async () => {
    const { privateKey, pub } = await keys();
    const t = await new SignJWT({ t: "login", sub: "u_1", email: "a@b.com" })
      .setProtectedHeader({ alg: "EdDSA", typ: "login+jwt" })
      .setIssuer(ISS)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(privateKey);
    const env = { SESSION_PUBLIC_JWK: pub, ISSUER: ISS } as Env;
    expect(await getSessionIdentity(req(t), env)).toBeNull();
  });

  it("requires sub, so a cookie without an account id is not a session", async () => {
    const { privateKey, pub } = await keys();
    const t = await mintSess(privateKey, { email: "a@b.com" });
    const env = { SESSION_PUBLIC_JWK: pub, ISSUER: ISS } as Env;
    expect(await getSessionIdentity(req(t), env)).toBeNull();
  });

  // Both formats configured at once is the state during the cutover: each cookie
  // must be read by whichever branch understands it.
  it("accepts either format while both are configured", async () => {
    const { privateKey, pub } = await keys();
    const env = { SESSION_PUBLIC_JWK: pub, ISSUER: ISS, SESSION_SECRET: SECRET } as Env;
    const modern = await mintSess(privateKey, { sub: "u_1", email: "new@b.com" });
    const legacy = await makeToken(SECRET, { t: "sess", e: "old@b.com" });
    expect(await getSessionIdentity(req(modern), env)).toEqual({ sub: "u_1", email: "new@b.com" });
    expect(await getSessionIdentity(req(legacy), env)).toEqual({ sub: null, email: "old@b.com" });
  });

  it("is null with no cookie and with neither format configured", async () => {
    expect(await getSessionIdentity(new Request("https://baby.32b.io/"), legacyEnv)).toBeNull();
    const t = await makeToken(SECRET, { t: "sess", e: "a@b.com" });
    expect(await getSessionIdentity(req(t), {} as Env)).toBeNull();
  });
});
