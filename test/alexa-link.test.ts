// The Alexa mini-AS: babylog-signed tokens for Amazon's account-linking
// client. The typ header is the wall between token kinds — every verify pins
// it, so a session cookie can never act as an Alexa token or vice versa.
import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import {
  mintLinkToken,
  verifyLinkToken,
  handleAlexaAuthorize,
  CODE_TYP,
  ACCESS_TYP,
  REFRESH_TYP,
} from "../src/alexa-link";
import { mintSession, readSession, SESSION_COOKIE } from "../src/session";

const SECRET = "alexa-oauth-secret-32-bytes-long!!!!";
const env = { ALEXA_OAUTH_HMAC_SECRET: SECRET };
const ID = { sub: "u_01ABC", email: "ana@example.com" };

describe("link tokens", () => {
  it("round-trips each kind under its own typ", async () => {
    for (const typ of [CODE_TYP, ACCESS_TYP, REFRESH_TYP]) {
      const tok = await mintLinkToken(env, typ, ID, 60);
      expect(await verifyLinkToken(env, tok, typ)).toMatchObject(ID);
    }
  });

  it("rejects a token under any other kind's typ", async () => {
    const access = await mintLinkToken(env, ACCESS_TYP, ID, 60);
    expect(await verifyLinkToken(env, access, REFRESH_TYP)).toBeNull();
    expect(await verifyLinkToken(env, access, CODE_TYP)).toBeNull();
  });

  it("refuses a token from another issuer", async () => {
    const forged = await new SignJWT({ email: ID.email })
      .setProtectedHeader({ alg: "HS256", typ: ACCESS_TYP })
      .setSubject(ID.sub)
      .setIssuer("https://evil.example")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifyLinkToken(env, forged, ACCESS_TYP)).toBeNull();
  });

  it("rejects a web session cookie as an Alexa token", async () => {
    const sess = await mintSession({ SESSION_HMAC_SECRET: SECRET }, ID);
    // Same HMAC key on purpose: even then the typ wall must hold.
    expect(await verifyLinkToken(env, sess, ACCESS_TYP)).toBeNull();
  });

  it("rejects an Alexa access token as a web session — the wall holds both ways", async () => {
    const access = await mintLinkToken(env, ACCESS_TYP, ID, 60);
    // Same HMAC key on purpose again; readSession pins typ bsess+jwt.
    const req = new Request("https://baby.32b.io/app", {
      headers: { Cookie: `${SESSION_COOKIE}=${access}` },
    });
    expect(await readSession(req, { SESSION_HMAC_SECRET: SECRET })).toBeNull();
  });

  it("rejects expiry and the wrong secret", async () => {
    const tok = await mintLinkToken(env, ACCESS_TYP, ID, -1);
    expect(await verifyLinkToken(env, tok, ACCESS_TYP)).toBeNull();
    const other = await mintLinkToken(
      { ALEXA_OAUTH_HMAC_SECRET: "a-completely-different-32-byte-key!!" },
      ACCESS_TYP,
      ID,
      60
    );
    expect(await verifyLinkToken(env, other, ACCESS_TYP)).toBeNull();
  });

  it("keeps extra claims (redirect_uri, jti) for codes", async () => {
    const tok = await mintLinkToken(env, CODE_TYP, ID, 60, {
      redirect_uri: "https://layla.amazon.com/api/skill/link/V123",
      jti: "j1",
    });
    const got = await verifyLinkToken(env, tok, CODE_TYP);
    expect(got?.redirect_uri).toBe("https://layla.amazon.com/api/skill/link/V123");
    expect(got?.jti).toBe("j1");
  });
});

const SESS_SECRET = "session-secret-32-bytes-long!!!!!!!!";

const REDIRECT = "https://layla.amazon.com/api/skill/link/V123";
const authorizeEnv = {
  SESSION_HMAC_SECRET: SESS_SECRET,
  ALEXA_OAUTH_HMAC_SECRET: SECRET,
  ALEXA_LINK_CLIENT_ID: "alexa",
  ALEXA_LINK_REDIRECTS: `https://pitangui.amazon.com/api/skill/link/V123,${REDIRECT}`,
} as never;

const authorizeUrl = (over: Record<string, string> = {}) => {
  const u = new URL("https://baby.32b.io/auth/alexa/authorize");
  const params = {
    response_type: "code",
    client_id: "alexa",
    redirect_uri: REDIRECT,
    state: "st-1",
    ...over,
  };
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
};

describe("handleAlexaAuthorize", () => {
  it("400 with no Location for an unknown client or unregistered redirect", async () => {
    for (const bad of [
      authorizeUrl({ client_id: "evil" }),
      authorizeUrl({ redirect_uri: "https://evil.example/cb" }),
      authorizeUrl({ redirect_uri: REDIRECT + "/" }),
    ]) {
      const res = await handleAlexaAuthorize(new Request(bad), authorizeEnv);
      expect(res.status).toBe(400);
      expect(res.headers.get("Location")).toBeNull();
    }
  });

  it("redirects a wrong response_type back to Amazon as an OAuth error", async () => {
    const res = await handleAlexaAuthorize(
      new Request(authorizeUrl({ response_type: "token" })),
      authorizeEnv
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("error")).toBe("unsupported_response_type");
    expect(loc.searchParams.get("state")).toBe("st-1");
  });

  it("bounces a sessionless GET through /auth/login with next", async () => {
    const res = await handleAlexaAuthorize(new Request(authorizeUrl()), authorizeEnv);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!, "https://baby.32b.io");
    expect(loc.pathname).toBe("/auth/login");
    const next = loc.searchParams.get("next")!;
    expect(next.startsWith("/auth/alexa/authorize?")).toBe(true);
    expect(new URL("https://baby.32b.io" + next).searchParams.get("state")).toBe("st-1");
  });

  it("shows a confirmation page — not a code — on a GET with a live session", async () => {
    const sess = await mintSession({ SESSION_HMAC_SECRET: SESS_SECRET }, ID);
    const res = await handleAlexaAuthorize(
      new Request(authorizeUrl(), { headers: { Cookie: `${SESSION_COOKIE}=${sess}` } }),
      authorizeEnv
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain(ID.email);
    expect(html).toContain('method="POST"');
    expect(html).not.toContain("code=");
  });

  it("mints a code only on the confirming POST, no-storing the redirect", async () => {
    const sess = await mintSession({ SESSION_HMAC_SECRET: SESS_SECRET }, ID);
    const res = await handleAlexaAuthorize(
      new Request("https://baby.32b.io/auth/alexa/authorize", {
        method: "POST",
        headers: {
          Cookie: `${SESSION_COOKIE}=${sess}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          response_type: "code",
          client_id: "alexa",
          redirect_uri: REDIRECT,
          state: "st-1",
        }).toString(),
      }),
      authorizeEnv
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("st-1");
    const claims = await verifyLinkToken(authorizeEnv, loc.searchParams.get("code")!, CODE_TYP);
    expect(claims).toMatchObject({ ...ID, redirect_uri: REDIRECT });
    expect(claims?.jti).toBeTruthy();
  });

  it("refuses a sessionless POST without minting (bounces to login)", async () => {
    const res = await handleAlexaAuthorize(
      new Request("https://baby.32b.io/auth/alexa/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          response_type: "code",
          client_id: "alexa",
          redirect_uri: REDIRECT,
          state: "st-1",
        }).toString(),
      }),
      authorizeEnv
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!, "https://baby.32b.io");
    expect(loc.pathname).toBe("/auth/login");
    expect(loc.searchParams.get("code")).toBeNull();
  });

  it("400s a POST with a forged redirect_uri even with a live session", async () => {
    const sess = await mintSession({ SESSION_HMAC_SECRET: SESS_SECRET }, ID);
    const res = await handleAlexaAuthorize(
      new Request("https://baby.32b.io/auth/alexa/authorize", {
        method: "POST",
        headers: {
          Cookie: `${SESSION_COOKIE}=${sess}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          response_type: "code",
          client_id: "alexa",
          redirect_uri: "https://evil.example/cb",
          state: "st-1",
        }).toString(),
      }),
      authorizeEnv
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("escapes a crafted state in the confirmation page", async () => {
    const sess = await mintSession({ SESSION_HMAC_SECRET: SESS_SECRET }, ID);
    const res = await handleAlexaAuthorize(
      new Request(authorizeUrl({ state: '"><script>x' }), {
        headers: { Cookie: `${SESSION_COOKIE}=${sess}` },
      }),
      authorizeEnv
    );
    const html = await res.text();
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&quot;&gt;&lt;script&gt;x");
  });
});
