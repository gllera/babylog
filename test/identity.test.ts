import { describe, expect, it } from "vitest";
import { getIdentityEmail } from "../src/identity";
import type { Env } from "../src/types";
import { ISS, keys, mintLegacy, mintSess } from "./sess-helpers";

const SECRET = "test-secret";

const baseEnv = {
  TEAM_DOMAIN: "https://example.cloudflareaccess.com",
  POLICY_AUD: "aud",
};

const cookie = (tok: string, extra: Record<string, string> = {}) =>
  new Request("https://baby.32b.io/app", {
    headers: { Cookie: `sess=${tok}`, ...extra },
  });

describe("getIdentityEmail precedence", () => {
  it("a valid sess cookie with no JWT header resolves to the cookie's email", async () => {
    const { privateKey, pub } = await keys();
    const tok = await mintSess(privateKey, { sub: "u_1", email: "Ana@Example.com" });
    const env = { ...baseEnv, SESSION_PUBLIC_JWK: pub, ISSUER: ISS } as unknown as Env;
    expect(await getIdentityEmail(cookie(tok), env)).toBe("ana@example.com");
  });

  it("a garbage JWT header falls through to the valid cookie's email", async () => {
    const { privateKey, pub } = await keys();
    const tok = await mintSess(privateKey, { sub: "u_1", email: "ana@example.com" });
    const env = { ...baseEnv, SESSION_PUBLIC_JWK: pub, ISSUER: ISS } as unknown as Env;
    const req = cookie(tok, { "Cf-Access-Jwt-Assertion": "not-a-jwt" });
    expect(await getIdentityEmail(req, env)).toBe("ana@example.com");
  });

  it("a valid cookie but an env without SESSION_PUBLIC_JWK resolves to null", async () => {
    const { privateKey } = await keys();
    const tok = await mintSess(privateKey, { sub: "u_1", email: "ana@example.com" });
    const env = { ...baseEnv } as unknown as Env;
    expect(await getIdentityEmail(cookie(tok), env)).toBeNull();
  });

  it("a cookie signed by another key resolves to null", async () => {
    const mine = await keys();
    const theirs = await keys();
    const tok = await mintSess(theirs.privateKey, { sub: "u_1", email: "ana@example.com" });
    const env = { ...baseEnv, SESSION_PUBLIC_JWK: mine.pub, ISSUER: ISS } as unknown as Env;
    expect(await getIdentityEmail(cookie(tok), env)).toBeNull();
  });

  // The end-to-end half of the legacy retirement: /app gates on this function, so
  // this is the assertion that a pre-cutover cookie cannot open the app — not just
  // that the verifier below it says no.
  it("a legacy HMAC cookie resolves to null even with the old secret present", async () => {
    const { pub } = await keys();
    const tok = await mintLegacy(SECRET, { t: "sess", e: "ana@example.com" });
    const env = {
      ...baseEnv,
      SESSION_PUBLIC_JWK: pub,
      ISSUER: ISS,
      SESSION_SECRET: SECRET,
    } as unknown as Env;
    expect(await getIdentityEmail(cookie(tok), env)).toBeNull();
  });

  it("DEV_USER_EMAIL only answers on a local origin", async () => {
    const env = {
      ...baseEnv,
      DEV_USER_EMAIL: "Dev@Example.com",
    } as unknown as Env;
    const localReq = new Request("http://localhost:8787/app");
    expect(await getIdentityEmail(localReq, env)).toBe("dev@example.com");

    const prodReq = new Request("https://baby.32b.io/app");
    expect(await getIdentityEmail(prodReq, env)).toBeNull();
  });
});
