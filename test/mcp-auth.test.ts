// /mcp as an OAuth 2.1 protected resource: what it takes, what it refuses, and
// the two walls that make it a resource server rather than a place that trusts
// anything auth.32b.io signed.
//
// Every test stands up a throwaway authorization server — its own issuer, its
// own Ed25519 key pair, its own discovery document — and stubs fetch to serve
// it. A distinct issuer per test is what keeps the discovery and JWKS caches in
// src/oidc.ts (which this module reuses) from leaking between cases, without the
// production code growing a reset hook only tests would ever call. Same shape as
// test/oidc.test.ts, for the same reason.
//
// Ed25519 and not RSA on purpose: auth signs EVERY access token with its session
// key regardless of what an application's id_token uses, so EdDSA is the
// algorithm this path meets in production, and a test that only ever exercised
// RS256 would not notice a verifier that cannot do the other one.

import { describe, expect, it, afterEach, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { MCP_RESOURCE, authorizeMcp, protectedResourceMetadata } from "../src/mcp-auth";
import type { Env } from "../src/types";

const EMAIL = "Ana@Example.com";

let seq = 0;

type As = {
  issuer: string;
  env: Env;
  // An access token exactly as auth mints one: RFC 9068 `typ`, audienced to
  // this resource, carrying the claims src/mcp-auth.ts reads.
  accessToken: (claims?: Record<string, unknown>) => Promise<string>;
  // A token signed by a key this authorization server does not publish.
  forged: (claims?: Record<string, unknown>) => Promise<string>;
};

async function stubAs(): Promise<As> {
  const issuer = `https://auth.test/t/32b_${++seq}`;
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "EdDSA", use: "sig" };
  const { privateKey: strangerKey } = await generateKeyPair("EdDSA", { extractable: true });

  const sign = (key: CryptoKey) => async (claims: Record<string, unknown> = {}) => {
    const { typ = "at+jwt", aud = MCP_RESOURCE, iss = issuer, ...rest } = claims;
    const jwt = new SignJWT({
      client_id: "mcp-client",
      scope: "openid email",
      sid: "s_1",
      email: EMAIL,
      ...rest,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "k1", typ: typ as string })
      .setIssuer(iss as string)
      .setAudience(aud as string)
      .setSubject("u_1")
      .setIssuedAt();
    if (!("exp" in rest)) jwt.setExpirationTime("1h");
    return jwt.sign(key);
  };

  const as: As = {
    issuer,
    env: { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "babylog" } as unknown as Env,
    accessToken: sign(privateKey),
    forged: sign(strangerKey),
  };

  vi.stubGlobal("fetch", async (input: string | Request) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
      });
    }
    if (url === `${issuer}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    throw new Error(`unexpected fetch: ${url}`);
  });

  return as;
}

const call = (as: As, token?: string) =>
  authorizeMcp(
    new Request(MCP_RESOURCE, {
      method: "POST",
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    }),
    as.env
  );

// The challenge parameters of a WWW-Authenticate header, which is the entire
// machine-readable half of a refusal.
const challenge = (res: Response): Record<string, string> => {
  const raw = res.headers.get("WWW-Authenticate") ?? "";
  expect(raw.startsWith("Bearer ")).toBe(true);
  const params: Record<string, string> = {};
  for (const [, k, v] of raw.matchAll(/([a-z_]+)="([^"]*)"/g)) params[k] = v;
  return params;
};

const refused = async (as: As, token: string, status: number, error: string) => {
  const gate = await call(as, token);
  expect(gate.ok).toBe(false);
  if (gate.ok) return null;
  expect(gate.response.status).toBe(status);
  const params = challenge(gate.response);
  expect(params.error).toBe(error);
  return params;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a token this resource accepts", () => {
  it("is verified against the keys auth publishes, and answers with its email", async () => {
    const as = await stubAs();
    const gate = await call(as, await as.accessToken());
    expect(gate).toEqual({ ok: true, email: "ana@example.com" });
  });
});

// -----------------------------------------------------------------------------
// The audience wall. THE test: it is what fails if somebody later "simplifies"
// the check to "signed by auth". auth's own /userinfo token is signed by the
// same key, carries the same issuer and the same subject, and is refused here —
// and /userinfo performs the mirror check, so neither token opens the other's
// door.
// -----------------------------------------------------------------------------
describe("the audience wall", () => {
  it("refuses a token minted for auth's own issuer — the kind /userinfo takes", async () => {
    const as = await stubAs();
    await refused(as, await as.accessToken({ aud: as.issuer }), 401, "invalid_token");
  });

  it("refuses a token minted for another resource entirely", async () => {
    const as = await stubAs();
    await refused(as, await as.accessToken({ aud: "https://srr.32b.io/mcp" }), 401, "invalid_token");
  });

  // The tenant segment of the issuer is load-bearing: another tenant's provider
  // is a different provider, whatever it signed.
  it("refuses a token from another issuer", async () => {
    const as = await stubAs();
    await refused(as, await as.accessToken({ iss: "https://auth.test/t/somebody" }), 401, "invalid_token");
  });
});

// -----------------------------------------------------------------------------
// The typ wall. A signature check alone does not say WHICH KIND of token it just
// verified, and this application's id_token is audienced to `babylog` — one
// rename away from colliding with a resource identifier. RFC 9068's `at+jwt` is
// what keeps an id_token from being spent as an access token.
// -----------------------------------------------------------------------------
describe("the typ wall", () => {
  it("refuses an id_token for the same subject with an aud that happens to match", async () => {
    const as = await stubAs();
    const idToken = await as.accessToken({ typ: "JWT", nonce: "n", auth_time: 1 });
    await refused(as, idToken, 401, "invalid_token");
  });
});

describe("the 401 that starts a login", () => {
  it("answers no token at all with the metadata URL and nothing else", async () => {
    const as = await stubAs();
    const gate = await call(as);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.response.status).toBe(401);
    const params = challenge(gate.response);
    // No `error`: RFC 6750 §3 wants one only when a credential was PRESENTED and
    // failed. A client with no token has nothing to fix, it has a login to start.
    expect(params.error).toBeUndefined();
    expect(params.resource_metadata).toBeTruthy();
  });

  // The whole discovery path is that one URL, so it has to be absolute, and it
  // has to be a path this Worker actually serves — asserted by serving it.
  it("points at metadata this Worker serves, naming this resource", async () => {
    const as = await stubAs();
    const gate = await call(as);
    if (gate.ok) throw new Error("unauthenticated request was allowed through");
    const url = new URL(challenge(gate.response).resource_metadata);
    expect(url.protocol).toBe("https:");
    expect(url.origin).toBe(new URL(MCP_RESOURCE).origin);

    const doc = protectedResourceMetadata(url, as.env);
    expect(doc).not.toBeNull();
    expect(await doc!.json()).toMatchObject({ resource: MCP_RESOURCE });
  });

  // The difference between "go and register" and "go and refresh". A client that
  // cannot tell them apart re-runs dynamic client registration on every expiry.
  it("marks a presented-and-failed token invalid_token, with a description", async () => {
    const as = await stubAs();
    const params = await refused(as, await as.forged(), 401, "invalid_token");
    expect(params!.error_description).toBeTruthy();
    expect(params!.resource_metadata).toBeTruthy();
  });

  it("refuses an expired token", async () => {
    const as = await stubAs();
    await refused(as, await as.accessToken({ exp: Math.floor(Date.now() / 1000) - 60 }), 401, "invalid_token");
  });

  it("refuses a token that is not a JWT at all", async () => {
    const as = await stubAs();
    await refused(as, "not-a-jwt", 401, "invalid_token");
  });

  it("refuses an Authorization header that is not a Bearer one", async () => {
    const as = await stubAs();
    const gate = await authorizeMcp(
      new Request(MCP_RESOURCE, { headers: { Authorization: "Basic aGk6dGhlcmU=" } }),
      as.env
    );
    expect(gate.ok).toBe(false);
  });

  // Nothing that arrived in the request may reach the header: a quote inside a
  // challenge parameter ends the quoted-string and everything after it is a
  // parameter of the attacker's choosing.
  it("never echoes the token into the challenge", async () => {
    const as = await stubAs();
    const gate = await call(as, 'x", scope="everything');
    if (gate.ok) throw new Error("garbage was allowed through");
    expect(gate.response.headers.get("WWW-Authenticate")).not.toContain("everything");
  });
});

// -----------------------------------------------------------------------------
// The email is not a nicety: households key on it (resolveTenant) and every MCP
// tool scopes its data by it. A token without one is a valid token this product
// has no name for — 401 would tell the client to go and get another one, which
// is precisely wrong, and an anonymous session would be worse.
// -----------------------------------------------------------------------------
describe("a valid token with no email", () => {
  it("is refused with 403, naming the scope that would fix it", async () => {
    const as = await stubAs();
    const params = await refused(
      as,
      await as.accessToken({ email: undefined, scope: "openid" }),
      403,
      "insufficient_scope"
    );
    expect(params!.scope).toContain("email");
    expect(params!.error_description).toContain("email");
  });

  it("is not a session — no email comes back", async () => {
    const as = await stubAs();
    const gate = await call(as, await as.accessToken({ email: undefined }));
    expect(gate.ok).toBe(false);
    expect((gate as { email?: string }).email).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// RFC 9728. Two paths because a client derives the second from the server URL's
// path and must not meet a 404 there.
// -----------------------------------------------------------------------------
describe("the protected resource metadata", () => {
  const bare = new URL("/.well-known/oauth-protected-resource", MCP_RESOURCE);
  const suffixed = new URL("/.well-known/oauth-protected-resource/mcp", MCP_RESOURCE);

  it("answers both paths, byte for byte the same document", async () => {
    const as = await stubAs();
    const a = protectedResourceMetadata(bare, as.env)!;
    const b = protectedResourceMetadata(suffixed, as.env)!;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(await a.text()).toBe(await b.text());
  });

  it("names this resource and the authorization server whose tokens it takes", async () => {
    const as = await stubAs();
    expect(await protectedResourceMetadata(bare, as.env)!.json()).toEqual({
      resource: MCP_RESOURCE,
      // The SAME string src/mcp-auth.ts checks `iss` against. Advertising a
      // different one would send clients to an authorization server whose
      // tokens are then refused here.
      authorization_servers: [as.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["openid", "email", "offline_access"],
    });
  });

  it("is JSON and cacheable", async () => {
    const as = await stubAs();
    const res = protectedResourceMetadata(bare, as.env)!;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Cache-Control")).toMatch(/max-age=[1-9]/);
  });

  it("answers nothing else — the suffix is this resource's path, not a wildcard", async () => {
    const as = await stubAs();
    for (const path of [
      "/.well-known/oauth-protected-resource/api",
      "/.well-known/oauth-protected-resource/mcp/extra",
      "/.well-known/oauth-authorization-server",
      "/mcp",
    ]) {
      expect(protectedResourceMetadata(new URL(path, MCP_RESOURCE), as.env)).toBeNull();
    }
  });
});
