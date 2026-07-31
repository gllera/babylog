// The `sess` cookie verifier: Ed25519 from auth.32b.io, and nothing else.
//
// The suite used to be half about an HMAC codec this Worker carried — makeToken /
// readToken, signed with a SESSION_SECRET shared with www.32b.io. Both are gone
// (www serves no login and mints no token), so what is left is verification of
// one format plus the standing proof that the retired one stays retired.
import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { getSessionEmail, getSessionIdentity, getSessionTokens } from "../src/session";
import type { Env } from "../src/types";
import { ISS, cookieReq as req, keys, mintLegacy, mintSess } from "./sess-helpers";

const SECRET = "test-secret";

describe("getSessionTokens", () => {
  it("extracts the sess cookies among other cookies", () => {
    expect(getSessionTokens("a=1; sess=tok.sig; b=2")).toEqual(["tok.sig"]);
    expect(getSessionTokens("sess=solo")).toEqual(["solo"]);
    expect(getSessionTokens("nosess=1")).toEqual([]);
    expect(getSessionTokens(null)).toEqual([]);
  });

  // The reason this is plural. `sess=` appearing inside another cookie's value
  // must not count, and the order the browser sent them is preserved because
  // specificity — which is what a planted cookie exploits — is expressed as order.
  it("returns every sess cookie, in order, and nothing that merely looks like one", () => {
    expect(getSessionTokens("sess=one; other=x; sess=two; nosess=three")).toEqual([
      "one",
      "two",
    ]);
    expect(getSessionTokens("presess=x; sessx=y")).toEqual([]);
  });
});

describe("getSessionEmail", () => {
  it("reads the request cookie and lowercases", async () => {
    const { privateKey, pub } = await keys();
    const env = { SESSION_PUBLIC_JWK: pub, ISSUER: ISS } as Env;
    const t = await mintSess(privateKey, { sub: "u_1", email: "Ana@Example.com" });
    expect(await getSessionEmail(req(t), env)).toBe("ana@example.com");
    expect(await getSessionEmail(new Request("https://baby.32b.io/app"), env)).toBeNull();
  });

  it("returns null for a validly-signed token carrying no email", async () => {
    const { privateKey, pub } = await keys();
    const env = { SESSION_PUBLIC_JWK: pub, ISSUER: ISS } as Env;
    const t = await mintSess(privateKey, { sub: "u_1" });
    expect(await getSessionEmail(req(t), env)).toBeNull();
  });
});

describe("getSessionIdentity", () => {
  it("reads an Ed25519 cookie from auth.32b.io", async () => {
    const { privateKey, pub } = await keys();
    const t = await mintSess(privateKey, { sub: "u_1", email: "A@B.com" });
    const env = { SESSION_PUBLIC_JWK: pub, ISSUER: ISS } as Env;
    expect(await getSessionIdentity(req(t), env)).toEqual({ sub: "u_1", email: "a@b.com" });
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

  // The retired format. Both of these assert the same property from opposite
  // sides, and the second is the one that matters: "we stopped configuring the
  // secret" is a deploy away from being undone, while "no code path reads it"
  // is not.
  it("refuses a legacy HMAC cookie when no secret is configured", async () => {
    const { pub } = await keys();
    const t = await mintLegacy(SECRET, { t: "sess", e: "a@b.com" });
    const env = { SESSION_PUBLIC_JWK: pub, ISSUER: ISS } as Env;
    expect(await getSessionIdentity(req(t), env)).toBeNull();
  });

  it("refuses a legacy HMAC cookie even with SESSION_SECRET still in the env", async () => {
    const { privateKey, pub } = await keys();
    // SESSION_SECRET is not in Env any more; cast past it deliberately, because
    // the point is that a leftover value in the environment changes nothing.
    const env = {
      SESSION_PUBLIC_JWK: pub,
      ISSUER: ISS,
      SESSION_SECRET: SECRET,
    } as unknown as Env;
    const modern = await mintSess(privateKey, { sub: "u_1", email: "new@b.com" });
    const legacy = await mintLegacy(SECRET, { t: "sess", e: "old@b.com" });
    expect(await getSessionIdentity(req(modern), env)).toEqual({ sub: "u_1", email: "new@b.com" });
    expect(await getSessionIdentity(req(legacy), env)).toBeNull();
  });

  // A browser can carry several `sess` cookies: the cookie is Domain=32b.io, so
  // any estate host can set one, and a host-only cookie planted by another host
  // sorts AHEAD of the real one. Reading only the first lets that host decide
  // which cookie is even considered — a junk plant becomes a lockout.
  it("does not let an unverifiable plant shadow the real session", async () => {
    const ours = await keys();
    const attacker = await keys();
    const env = { SESSION_PUBLIC_JWK: ours.pub, ISSUER: ISS } as Env;
    const real = await mintSess(ours.privateKey, { sub: "u_REAL", email: "real@b.com" });
    const plant = await mintSess(attacker.privateKey, {
      sub: "u_ATTACKER",
      email: "a@evil.example",
    });
    const both = new Request("https://baby.32b.io/", {
      headers: { Cookie: `sess=${plant}; sess=${real}` },
    });
    expect(await getSessionIdentity(both, env)).toEqual({ sub: "u_REAL", email: "real@b.com" });
  });

  // And the limit of that, asserted so nobody budgets for more: a plant that
  // VERIFIES is a session by every check available here, and it wins if it sorts
  // first. Only a `__Host-` cookie no other host can write closes that, which is
  // stage 3 in 32b-auth's roadmap.
  it("cannot tell a validly-signed plant from the browser's own session", async () => {
    const ours = await keys();
    const env = { SESSION_PUBLIC_JWK: ours.pub, ISSUER: ISS } as Env;
    const real = await mintSess(ours.privateKey, { sub: "u_REAL", email: "real@b.com" });
    const plant = await mintSess(ours.privateKey, { sub: "u_OTHER", email: "other@b.com" });
    const both = new Request("https://baby.32b.io/", {
      headers: { Cookie: `sess=${plant}; sess=${real}` },
    });
    expect(await getSessionIdentity(both, env)).toEqual({ sub: "u_OTHER", email: "other@b.com" });
  });

  it("is null with no cookie, and with no verification key configured", async () => {
    const { privateKey, pub } = await keys();
    const env = { SESSION_PUBLIC_JWK: pub, ISSUER: ISS } as Env;
    expect(await getSessionIdentity(new Request("https://baby.32b.io/"), env)).toBeNull();
    // A real cookie, no key to check it with: refused, and src/session.ts says so
    // in the log rather than leaving it to look like an estate-wide sign-out.
    const t = await mintSess(privateKey, { sub: "u_1", email: "a@b.com" });
    expect(await getSessionIdentity(req(t), {} as Env)).toBeNull();
  });
});
