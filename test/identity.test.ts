// Identity precedence across the two production auth paths, end to end.
//
// The cookie half changed shape at the OIDC conversion — babylog's own
// `__Host-bsess` replaced auth.32b.io's estate-wide `sess` — but what this file
// is for did not: /app, /api and /mcp all gate on getIdentityEmail, so this is
// where "a cookie that should not open the app cannot open the app" is asserted
// rather than merely implied by the verifier below it.
import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { getIdentityEmail } from "../src/identity";
import { SESSION_COOKIE, mintSession } from "../src/session";
import type { Env } from "../src/types";

const SECRET = "test-secret-at-least-32-bytes-long!!";

const baseEnv = {
  TEAM_DOMAIN: "https://example.cloudflareaccess.com",
  POLICY_AUD: "aud",
};

const env = { ...baseEnv, SESSION_HMAC_SECRET: SECRET } as unknown as Env;

const cookie = (raw: string, extra: Record<string, string> = {}) =>
  new Request("https://baby.32b.io/app", { headers: { Cookie: raw, ...extra } });

const session = async (claims = { sub: "u_1", email: "Ana@Example.com" }, e: Env = env) =>
  `${SESSION_COOKIE}=${await mintSession(e, claims)}`;

describe("getIdentityEmail precedence", () => {
  it("a valid session cookie with no JWT header resolves to its email", async () => {
    expect(await getIdentityEmail(cookie(await session()), env)).toBe("ana@example.com");
  });

  it("a garbage JWT header falls through to the valid cookie's email", async () => {
    const req = cookie(await session(), { "Cf-Access-Jwt-Assertion": "not-a-jwt" });
    expect(await getIdentityEmail(req, env)).toBe("ana@example.com");
  });

  it("a valid cookie but an env without SESSION_HMAC_SECRET resolves to null", async () => {
    const raw = await session();
    expect(await getIdentityEmail(cookie(raw), { ...baseEnv } as unknown as Env)).toBeNull();
  });

  it("a cookie signed with another secret resolves to null", async () => {
    const theirs = { SESSION_HMAC_SECRET: "a-completely-different-secret-value!!" } as unknown as Env;
    expect(await getIdentityEmail(cookie(await session(undefined, theirs)), env)).toBeNull();
  });

  // The end-to-end half of the conversion. /app gates on this function, so this
  // is the assertion that an estate cookie cannot open the app — not just that
  // the verifier says no. It is the property auth.32b.io's `__Host-` flip is
  // waiting on, asserted at the gate a user actually passes through.
  it("auth.32b.io's shared sess cookie resolves to null, however well-formed", async () => {
    const shared = await new SignJWT({ t: "sess", sub: "u_1", email: "ana@example.com" })
      .setProtectedHeader({ alg: "HS256", typ: "sess+jwt" })
      .setIssuer("https://auth.32b.io")
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(new TextEncoder().encode(SECRET));
    expect(await getIdentityEmail(cookie(`sess=${shared}`), env)).toBeNull();
  });

  it("DEV_USER_EMAIL only answers on a local origin", async () => {
    const devEnv = { ...baseEnv, DEV_USER_EMAIL: "Dev@Example.com" } as unknown as Env;
    expect(await getIdentityEmail(new Request("http://localhost:8787/app"), devEnv)).toBe(
      "dev@example.com"
    );
    expect(await getIdentityEmail(new Request("https://baby.32b.io/app"), devEnv)).toBeNull();
  });
});
