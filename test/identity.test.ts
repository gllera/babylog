// What a browser request's identity is, end to end.
//
// It used to be a precedence question — a Cloudflare Access JWT on
// baby.llera.eu, babylog's own cookie on baby.32b.io — and it is not one any
// more: /mcp verifies its own access tokens (src/mcp-auth.ts), so the Access
// app in front of llera.eu had nothing left to gate and the header it stamped
// is no longer read. What this file is for did not change: /app, /api and /mcp
// all gate on getIdentityEmail, so this is where "a credential that should not
// open the app cannot open the app" is asserted rather than merely implied by
// the verifier below it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { getIdentityEmail } from "../src/identity";
import { SESSION_COOKIE, mintSession } from "../src/session";
import type { Env } from "../src/types";

const SECRET = "test-secret-at-least-32-bytes-long!!";

// The two values that used to be `vars` in wrangler.jsonc: the Access team and
// the `baby-mcp` application's AUD tag.
const TEAM_DOMAIN = "https://example.cloudflareaccess.com";
const POLICY_AUD = "aud";

const env = { SESSION_HMAC_SECRET: SECRET } as unknown as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

const cookie = (raw: string, extra: Record<string, string> = {}) =>
  new Request("https://baby.32b.io/app", { headers: { Cookie: raw, ...extra } });

const session = async (claims = { sub: "u_1", email: "Ana@Example.com" }, e: Env = env) =>
  `${SESSION_COOKIE}=${await mintSession(e, claims)}`;

describe("getIdentityEmail precedence", () => {
  it("a valid session cookie with no JWT header resolves to its email", async () => {
    expect(await getIdentityEmail(cookie(await session()), env)).toBe("ana@example.com");
  });

  // The Access header is not an identity source any more, and this is the
  // assertion that says so with a JWT that would have passed every check the
  // deleted verifier made: this team's issuer, the `baby-mcp` app's AUD, RS256,
  // signed by a key the stubbed team JWKS publishes. It was a real credential
  // for as long as Cloudflare Access fronted baby.llera.eu and ran the whole
  // OAuth flow for MCP clients. /mcp verifies its own tokens now, so the header
  // is read by nothing — the team JWKS is not even fetched.
  it("a well-formed Cloudflare Access JWT resolves to null, and is not even checked", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    let askedForKeys = false;
    vi.stubGlobal("fetch", async (input: string | Request) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
        askedForKeys = true;
        return Response.json({ keys: [jwk] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const assertion = await new SignJWT({ email: "ana@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(TEAM_DOMAIN)
      .setAudience(POLICY_AUD)
      .setSubject("u_1")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    // The vars are gone from wrangler.jsonc and from Env; handed over here
    // anyway, so the test would still pass if somebody put them back.
    const withVars = { ...env, TEAM_DOMAIN, POLICY_AUD } as unknown as Env;
    const req = new Request("https://baby.32b.io/app", {
      headers: { "Cf-Access-Jwt-Assertion": assertion },
    });
    expect(await getIdentityEmail(req, withVars)).toBeNull();
    expect(askedForKeys).toBe(false);
    // ...and a request that also carries a real session is that session's.
    const both = cookie(await session(), { "Cf-Access-Jwt-Assertion": assertion });
    expect(await getIdentityEmail(both, withVars)).toBe("ana@example.com");
  });

  it("a valid cookie but an env without SESSION_HMAC_SECRET resolves to null", async () => {
    const raw = await session();
    expect(await getIdentityEmail(cookie(raw), {} as unknown as Env)).toBeNull();
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
    const devEnv = { DEV_USER_EMAIL: "Dev@Example.com" } as unknown as Env;
    expect(await getIdentityEmail(new Request("http://localhost:8787/app"), devEnv)).toBe(
      "dev@example.com"
    );
    expect(await getIdentityEmail(new Request("https://baby.32b.io/app"), devEnv)).toBeNull();
  });
});
