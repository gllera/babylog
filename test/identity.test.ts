import { describe, expect, it } from "vitest";
import { getIdentityEmail } from "../src/identity";
import { makeToken } from "../src/session";
import type { Env } from "../src/types";

const SECRET = "test-secret";

const baseEnv = {
  TEAM_DOMAIN: "https://example.cloudflareaccess.com",
  POLICY_AUD: "aud",
};

describe("getIdentityEmail precedence", () => {
  it("a valid sess cookie with no JWT header resolves to the cookie's email", async () => {
    const tok = await makeToken(SECRET, { t: "sess", e: "Ana@Example.com" });
    const env = { ...baseEnv, SESSION_SECRET: SECRET } as unknown as Env;
    const req = new Request("https://baby.32b.io/app", {
      headers: { Cookie: `sess=${tok}` },
    });
    expect(await getIdentityEmail(req, env)).toBe("ana@example.com");
  });

  it("a garbage JWT header falls through to the valid cookie's email", async () => {
    const tok = await makeToken(SECRET, { t: "sess", e: "ana@example.com" });
    const env = { ...baseEnv, SESSION_SECRET: SECRET } as unknown as Env;
    const req = new Request("https://baby.32b.io/app", {
      headers: {
        Cookie: `sess=${tok}`,
        "Cf-Access-Jwt-Assertion": "not-a-jwt",
      },
    });
    expect(await getIdentityEmail(req, env)).toBe("ana@example.com");
  });

  it("a valid cookie but an env without SESSION_SECRET resolves to null", async () => {
    const tok = await makeToken(SECRET, { t: "sess", e: "ana@example.com" });
    const env = { ...baseEnv } as unknown as Env;
    const req = new Request("https://baby.32b.io/app", {
      headers: { Cookie: `sess=${tok}` },
    });
    expect(await getIdentityEmail(req, env)).toBeNull();
  });

  it("a cookie forged with a different secret resolves to null", async () => {
    const tok = await makeToken("other-secret", { t: "sess", e: "ana@example.com" });
    const env = { ...baseEnv, SESSION_SECRET: SECRET } as unknown as Env;
    const req = new Request("https://baby.32b.io/app", {
      headers: { Cookie: `sess=${tok}` },
    });
    expect(await getIdentityEmail(req, env)).toBeNull();
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
