// babylog as an OIDC relying party: the two legs of the code+PKCE flow.
//
// Every test stands up a throwaway IdP — its own issuer, its own key pair, its
// own discovery document — and stubs fetch to serve it. A distinct issuer per
// test is what keeps the discovery and JWKS caches in src/oidc.ts from leaking
// between cases, without the production code growing a reset hook that only
// tests would ever call.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { beginLogin, handleCallback, logout } from "../src/oidc";
import { SESSION_COOKIE, readSession } from "../src/session";
import type { Env } from "../src/types";

const ORIGIN = "https://baby.32b.io";
const REDIRECT = `${ORIGIN}/auth/callback`;
const CLIENT_ID = "babylog";
const CLIENT_SECRET = "s3cr3t-from-the-csprng";
const SESSION_HMAC_SECRET = "test-secret-at-least-32-bytes-long!!";

let seq = 0;

type Idp = {
  issuer: string;
  env: Env;
  idToken: (claims?: Record<string, unknown>) => Promise<string>;
  // What the stubbed token endpoint will answer with next.
  token: { status: number; body: unknown };
  // Every request the client made to the IdP, for asserting on the wire format.
  calls: { url: string; init?: RequestInit }[];
};

async function stubIdp(): Promise<Idp> {
  const issuer = `https://auth.test/t/t_${++seq}`;
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };

  const idp: Idp = {
    issuer,
    env: {
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_HMAC_SECRET,
    } as unknown as Env,
    idToken: (claims = {}) =>
      new SignJWT({ email: "ana@example.com", email_verified: true, ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(issuer)
        .setAudience(CLIENT_ID)
        .setSubject("u_1")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey),
    token: { status: 200, body: null },
    calls: [],
  };

  vi.stubGlobal("fetch", async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    idp.calls.push({ url, init });
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        id_token_signing_alg_values_supported: ["RS256", "EdDSA"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url === `${issuer}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    if (url === `${issuer}/token`) {
      const body = idp.token.body ?? {
        access_token: "at",
        token_type: "Bearer",
        expires_in: 3600,
        id_token: await idp.idToken({ nonce: lastNonce }),
      };
      return Response.json(body, { status: idp.token.status });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  return idp;
}

// The nonce the client put in the authorization request, captured so the stubbed
// token endpoint can echo it back the way a real IdP would.
let lastNonce = "";

const flowOf = (res: Response): { cookie: string; state: string } => {
  const set = res.headers.getSetCookie().find((c) => c.startsWith("__Host-blogin="))!;
  const value = set.slice("__Host-blogin=".length).split(";")[0];
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
  lastNonce = parsed.nonce;
  return { cookie: `__Host-blogin=${value}`, state: parsed.state };
};

const start = async (idp: Idp, next = "/app") => {
  const res = await beginLogin(new Request(`${ORIGIN}/auth/login?next=${encodeURIComponent(next)}`), idp.env);
  return { res, ...flowOf(res), params: new URL(res.headers.get("Location")!).searchParams };
};

const callback = (idp: Idp, cookie: string, query: string) =>
  handleCallback(new Request(`${REDIRECT}?${query}`, { headers: { Cookie: cookie } }), idp.env);

const sessionOf = async (res: Response, env: Env) => {
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!set) return null;
  return readSession(
    new Request(`${ORIGIN}/app`, { headers: { Cookie: set.split(";")[0] } }),
    env
  );
};

beforeEach(() => {
  seq += 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the authorization request", () => {
  it("carries exactly what a code+PKCE client must send", async () => {
    const idp = await stubIdp();
    const { res, params } = await start(idp);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).origin + new URL(res.headers.get("Location")!).pathname)
      .toBe(`${idp.issuer}/authorize`);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(REDIRECT);
    expect(params.get("scope")).toBe("openid email");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("state")).toBeTruthy();
    expect(params.get("nonce")).toBeTruthy();
    expect(params.get("code_challenge")).toBeTruthy();
  });

  // The verifier never leaves this Worker until /token, and the challenge is the
  // only thing the browser ever sees. If these two ever stopped agreeing, PKCE
  // would still LOOK present and would defend nothing.
  it("sends the S256 hash of the verifier it kept, not the verifier", async () => {
    const idp = await stubIdp();
    const { cookie, params } = await start(idp);
    const verifier = JSON.parse(
      Buffer.from(cookie.split("=")[1], "base64url").toString()
    ).verifier as string;
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    );
    expect(params.get("code_challenge")).toBe(Buffer.from(digest).toString("base64url"));
    expect(params.get("code_challenge")).not.toBe(verifier);
  });

  it("keeps the flow cookie host-only and short-lived", async () => {
    const idp = await stubIdp();
    const { res } = await start(idp);
    const set = res.headers.getSetCookie().find((c) => c.startsWith("__Host-blogin="))!;
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
    // Lax, not Strict: the callback IS a top-level navigation from auth.32b.io,
    // and Strict would drop the cookie on exactly the request that needs it.
    expect(set).toContain("SameSite=Lax");
    expect(set).not.toContain("Domain=");
    expect(set).toMatch(/Max-Age=[1-9]/);
  });

  it("gives two logins two different states, nonces and verifiers", async () => {
    const idp = await stubIdp();
    const a = JSON.parse(Buffer.from((await start(idp)).cookie.split("=")[1], "base64url").toString());
    const b = JSON.parse(Buffer.from((await start(idp)).cookie.split("=")[1], "base64url").toString());
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.verifier).not.toBe(b.verifier);
  });
});

// `next` is caller-controlled and ends up in a Location header, which is the
// classic open redirect. It is validated on the way IN rather than trusted on
// the way out, and a signature on the flow cookie would not help: an attacker
// who can plant a cookie can also start a real login and be handed a signed one.
describe("where it sends you afterwards", () => {
  it("keeps a same-origin path", async () => {
    const idp = await stubIdp();
    const { cookie } = await start(idp, "/growth");
    expect(JSON.parse(Buffer.from(cookie.split("=")[1], "base64url").toString()).next).toBe("/growth");
  });

  it.each(["https://evil.example/x", "//evil.example/x", "http://baby.32b.io/x", "\\\\evil.example"])(
    "refuses %s and falls back to /app",
    async (next) => {
      const idp = await stubIdp();
      const { cookie } = await start(idp, next);
      expect(JSON.parse(Buffer.from(cookie.split("=")[1], "base64url").toString()).next).toBe("/app");
    }
  );
});

describe("the callback", () => {
  it("exchanges the code and mints a babylog session", async () => {
    const idp = await stubIdp();
    const { cookie, state } = await start(idp);
    const res = await callback(idp, cookie, `code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/app");
    expect(await sessionOf(res, idp.env)).toEqual({ sub: "u_1", email: "ana@example.com" });
  });

  it("authenticates itself with the client secret and proves PKCE", async () => {
    const idp = await stubIdp();
    const { cookie, state } = await start(idp);
    await callback(idp, cookie, `code=abc&state=${state}`);
    const call = idp.calls.find((c) => c.url.endsWith("/token"))!;
    const body = new URLSearchParams(call.init!.body as string);
    expect(call.init!.method).toBe("POST");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("abc");
    expect(body.get("redirect_uri")).toBe(REDIRECT);
    expect(body.get("code_verifier")).toBeTruthy();
    // client_secret_basic: the secret is a credential, not a form field.
    const auth = (call.init!.headers as Record<string, string>)["authorization"];
    expect(Buffer.from(auth.slice("Basic ".length), "base64").toString()).toBe(
      `${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`
    );
    expect(body.get("client_secret")).toBeNull();
  });

  it("clears the flow cookie once the flow is over", async () => {
    const idp = await stubIdp();
    const { cookie, state } = await start(idp);
    const res = await callback(idp, cookie, `code=abc&state=${state}`);
    expect(res.headers.getSetCookie().some((c) => /^__Host-blogin=;.*Max-Age=0/.test(c))).toBe(true);
  });

  it("returns to the path the login started from", async () => {
    const idp = await stubIdp();
    const { cookie, state } = await start(idp, "/growth");
    const res = await callback(idp, cookie, `code=abc&state=${state}`);
    expect(res.headers.get("Location")).toBe("/growth");
  });
});

describe("what the callback refuses", () => {
  const refused = async (res: Response, env: Env) => {
    expect(res.status).toBe(400);
    expect(await sessionOf(res, env)).toBeNull();
  };

  it("a state that does not match the flow cookie", async () => {
    const idp = await stubIdp();
    const { cookie } = await start(idp);
    await refused(await callback(idp, cookie, "code=abc&state=not-the-one"), idp.env);
  });

  it("a callback with no flow cookie at all", async () => {
    const idp = await stubIdp();
    const { state } = await start(idp);
    await refused(await callback(idp, "", `code=abc&state=${state}`), idp.env);
  });

  it("an error handed back by the IdP", async () => {
    const idp = await stubIdp();
    const { cookie, state } = await start(idp);
    await refused(await callback(idp, cookie, `error=access_denied&state=${state}`), idp.env);
    expect(idp.calls.some((c) => c.url.endsWith("/token"))).toBe(false);
  });

  it("a token endpoint that refuses the exchange", async () => {
    const idp = await stubIdp();
    const { cookie, state } = await start(idp);
    idp.token = { status: 400, body: { error: "invalid_grant" } };
    await refused(await callback(idp, cookie, `code=abc&state=${state}`), idp.env);
  });

  // The four id_token checks. Each is the only thing standing between a token
  // that verifies and a token that verifies AND is about this login.
  it("an id_token whose nonce is not the one we sent", async () => {
    const idp = await stubIdp();
    const { cookie, state } = await start(idp);
    idp.token = {
      status: 200,
      body: { id_token: await idp.idToken({ nonce: "somebody-elses-nonce" }) },
    };
    await refused(await callback(idp, cookie, `code=abc&state=${state}`), idp.env);
  });

  it("an id_token with no nonce when one was requested", async () => {
    const idp = await stubIdp();
    const { cookie, state } = await start(idp);
    idp.token = { status: 200, body: { id_token: await idp.idToken({}) } };
    await refused(await callback(idp, cookie, `code=abc&state=${state}`), idp.env);
  });

  it("an id_token audienced to another client", async () => {
    const idp = await stubIdp();
    const { cookie, state } = await start(idp);
    const other = await new SignJWT({ email: "ana@example.com", nonce: lastNonce })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(idp.issuer)
      .setAudience("some-other-client")
      .setSubject("u_1")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign((await generateKeyPair("RS256", { extractable: true })).privateKey);
    idp.token = { status: 200, body: { id_token: other } };
    await refused(await callback(idp, cookie, `code=abc&state=${state}`), idp.env);
  });

  it("an id_token signed by a key the IdP does not publish", async () => {
    const idp = await stubIdp();
    const { cookie, state } = await start(idp);
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const forged = await new SignJWT({ email: "evil@example.com", nonce: lastNonce })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(idp.issuer)
      .setAudience(CLIENT_ID)
      .setSubject("u_EVIL")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    idp.token = { status: 200, body: { id_token: forged } };
    await refused(await callback(idp, cookie, `code=abc&state=${state}`), idp.env);
  });

  it("an id_token with no email, which is the one claim this product needs", async () => {
    const idp = await stubIdp();
    const { cookie, state } = await start(idp);
    idp.token = {
      status: 200,
      body: { id_token: await idp.idToken({ nonce: lastNonce, email: undefined }) },
    };
    await refused(await callback(idp, cookie, `code=abc&state=${state}`), idp.env);
  });

  it("a response carrying no id_token at all", async () => {
    const idp = await stubIdp();
    const { cookie, state } = await start(idp);
    idp.token = { status: 200, body: { access_token: "at", token_type: "Bearer" } };
    await refused(await callback(idp, cookie, `code=abc&state=${state}`), idp.env);
  });

  // A refusal that leaves the flow cookie behind wedges the browser: every retry
  // replays a state whose code is already spent.
  it("and clears the flow cookie on the way out, so a retry is clean", async () => {
    const idp = await stubIdp();
    const { cookie } = await start(idp);
    const res = await callback(idp, cookie, "code=abc&state=wrong");
    expect(res.headers.getSetCookie().some((c) => /^__Host-blogin=;.*Max-Age=0/.test(c))).toBe(true);
  });
});

describe("logout", () => {
  it("clears the session cookie and lands somewhere harmless", () => {
    const res = logout();
    expect(res.status).toBe(302);
    expect(
      res.headers.getSetCookie().some((c) => new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`).test(c))
    ).toBe(true);
  });
});
