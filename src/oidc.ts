// -----------------------------------------------------------------------------
// babylog as an OpenID Connect relying party.
//
// auth.32b.io is the estate's IdP and babylog is a confidential client of it:
// authorization code + PKCE, exchanged server-side once, after which this Worker
// mints its own session (src/session.ts) and does not talk to the IdP again
// until that session ends. That is the client shape stage 3 of 32b-auth's
// roadmap deliberately scoped to — no refresh tokens, no introspection, no
// silent renewal — and it is why nothing here needs a token store.
//
// It replaces reading auth.32b.io's shared `sess` cookie. See src/session.ts for
// why that mattered more than the protocol upgrade did.
//
// Every endpoint is READ FROM DISCOVERY beneath the configured issuer, never
// hardcoded. The issuer is the one string this client pins, which is what lets
// the IdP move an endpoint without a coordinated deploy — and a second set of
// URLs meaning the same thing is the one migration OIDC gives you no way to
// perform.
// -----------------------------------------------------------------------------

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { clearSessionCookie, mintSession, sessionCookie } from "./session";
import type { Env } from "./types";

// `openid` for the flow, `email` because a household is keyed on one. Nothing
// else is advertised by the IdP and nothing else is wanted.
const SCOPE = "openid email";

// Host-only and unwritable by any other 32b.io host, which is the same property
// the IdP's own magic-link binding nonce relies on.
const FLOW_COOKIE = "__Host-blogin";

// Long enough for a first-time login that goes and reads an email, short enough
// that an abandoned one does not sit in the jar for a day.
const FLOW_MAX_AGE_S = 15 * 60;

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const random = (n: number): string => b64u(crypto.getRandomValues(new Uint8Array(n)));

const s256 = async (verifier: string): Promise<string> =>
  b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

// ---------------------------------------------------------------- discovery --

type Discovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

// Cached for the life of the isolate, keyed by issuer. The document changes
// about as often as the service is redeployed, and a cold isolate paying one
// extra fetch on its first login is the whole cost of not hardcoding endpoints.
const discoveryCache = new Map<string, Promise<Discovery>>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function discover(issuer: string): Promise<Discovery> {
  let hit = discoveryCache.get(issuer);
  if (!hit) {
    hit = fetch(`${issuer}/.well-known/openid-configuration`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`discovery ${r.status}`);
        return (await r.json()) as Discovery;
      })
      .catch((e) => {
        // A cached rejection would keep a transient failure alive for the life
        // of the isolate; evicting lets the next login retry.
        discoveryCache.delete(issuer);
        throw e;
      });
    discoveryCache.set(issuer, hit);
  }
  return hit;
}

const jwks = (uri: string) => {
  let hit = jwksCache.get(uri);
  if (!hit) {
    hit = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, hit);
  }
  return hit;
};

// -------------------------------------------------------------- the flow ----

type Flow = { state: string; nonce: string; verifier: string; next: string };

const packFlow = (f: Flow): string => b64u(new TextEncoder().encode(JSON.stringify(f)));

function unpackFlow(request: Request): Flow | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== FLOW_COOKIE) continue;
    try {
      const json = new TextDecoder().decode(
        Uint8Array.from(atob(part.slice(eq + 1).trim().replace(/-/g, "+").replace(/_/g, "/")), (c) =>
          c.charCodeAt(0)
        )
      );
      const f = JSON.parse(json) as Flow;
      if (f && typeof f.state === "string" && typeof f.verifier === "string") return f;
    } catch {
      /* an unreadable flow cookie is no flow cookie */
    }
  }
  return null;
}

// The flow cookie is deliberately NOT signed. A signature would defend against a
// tampered `next`, and `next` is validated below instead; against anything else
// it buys nothing, because an attacker who can write a cookie on this host can
// also start a genuine login and be handed a validly signed one. `__Host-` plus
// the state check is what actually carries the weight.
const flowCookie = (f: Flow): string =>
  `${FLOW_COOKIE}=${packFlow(f)}; Max-Age=${FLOW_MAX_AGE_S}; Path=/; HttpOnly; Secure; SameSite=Lax`;

const clearFlowCookie = (): string =>
  `${FLOW_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

// Where to land afterwards. Caller-controlled and destined for a Location
// header, so it is validated on the way in: a same-origin absolute path, and
// nothing that a browser could read as a host. `//evil` and `\\evil` are the two
// spellings that turn a path into an authority.
export function safeNext(raw: string | null): string {
  if (!raw) return "/app";
  if (!raw.startsWith("/")) return "/app";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/app";
  if (raw.includes("\\")) return "/app";
  return raw;
}

// --------------------------------------------------------------- leg one ----

// The redirect URI must match the registered string EXACTLY — the IdP compares
// it un-normalized, on purpose. Deriving it from the request's own origin means
// a request arriving on any host but the registered one builds a URI the IdP
// refuses to redirect to, which is the correct failure and not a silent one.
const redirectUri = (request: Request): string => `${new URL(request.url).origin}/auth/callback`;

export async function beginLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const flow: Flow = {
    state: random(16),
    nonce: random(16),
    // RFC 7636 wants 43-128 characters of unreserved ASCII; 32 random bytes
    // base64url is 43.
    verifier: random(32),
    next: safeNext(url.searchParams.get("next")),
  };

  const doc = await discover(env.OIDC_ISSUER!);
  const authorize = new URL(doc.authorization_endpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", env.OIDC_CLIENT_ID!);
  authorize.searchParams.set("redirect_uri", redirectUri(request));
  authorize.searchParams.set("scope", SCOPE);
  authorize.searchParams.set("state", flow.state);
  authorize.searchParams.set("nonce", flow.nonce);
  authorize.searchParams.set("code_challenge", await s256(flow.verifier));
  authorize.searchParams.set("code_challenge_method", "S256");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": flowCookie(flow),
      "Cache-Control": "no-store",
    },
  });
}

// --------------------------------------------------------------- leg two ----

// Fixed sentences chosen by lookup, never interpolation — the same rule the
// IdP's own error page follows. Nothing the IdP or the browser sent is echoed.
const REASONS: Record<string, string> = {
  no_flow: "This login has expired. Please start again.",
  state: "This login could not be verified. Please start again.",
  denied: "Sign-in was not completed.",
  exchange: "Could not complete sign-in. Please try again.",
  token: "Could not verify the sign-in. Please try again.",
};

const fail = (reason: keyof typeof REASONS): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Sign-in</title>` +
      `<p>${REASONS[reason]}</p><p><a href="/auth/login">Try again</a></p>`,
    {
      status: 400,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Always cleared: a flow cookie left behind wedges every retry on a
        // state whose code is already spent.
        "Set-Cookie": clearFlowCookie(),
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
      },
    }
  );

export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const flow = unpackFlow(request);
  if (!flow) return fail("no_flow");

  // The IdP reports failures by redirecting here with `error`; there is no code
  // to exchange and nothing to look up.
  if (url.searchParams.get("error")) return fail("denied");

  // Before anything is spent. This is what makes the callback belong to the
  // login this browser started rather than to one an attacker started.
  if (url.searchParams.get("state") !== flow.state) return fail("state");

  const code = url.searchParams.get("code");
  if (!code) return fail("state");

  const doc = await discover(env.OIDC_ISSUER!);

  let idToken: string;
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(request),
      code_verifier: flow.verifier,
    });
    // client_secret_basic. RFC 6749 §2.3.1 percent-encodes both halves before
    // base64 — with a base64url secret that is a no-op, but the rule is about
    // the format rather than about today's secret.
    const basic = btoa(
      `${encodeURIComponent(env.OIDC_CLIENT_ID!)}:${encodeURIComponent(env.OIDC_CLIENT_SECRET!)}`
    );
    const res = await fetch(doc.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        authorization: `Basic ${basic}`,
      },
      body: body.toString(),
    });
    if (!res.ok) return fail("exchange");
    const json = (await res.json()) as { id_token?: string };
    if (!json.id_token) return fail("exchange");
    idToken = json.id_token;
  } catch {
    return fail("exchange");
  }

  // Verified against the keys the IdP PUBLISHES, fetched from the jwks_uri in
  // its own discovery document — not against anything configured here. "The key
  // that signed it is the key we publish" is precisely what a half-finished
  // rotation breaks, and a client holding a pinned copy would not notice.
  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(idToken, jwks(doc.jwks_uri), {
      issuer: env.OIDC_ISSUER!,
      audience: env.OIDC_CLIENT_ID!,
      requiredClaims: ["iss", "aud", "sub", "exp", "iat", "nonce"],
    }));
  } catch {
    return fail("token");
  }

  // OIDC Core §3.1.3.7 step 11. The nonce is what ties this id_token to the
  // authorization request this browser made; without it a token replayed from
  // another login verifies perfectly.
  if (claims.nonce !== flow.nonce) return fail("token");

  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  if (!claims.sub || !email) return fail("token");

  const session = await mintSession(env, { sub: String(claims.sub), email });
  const headers = new Headers({ Location: flow.next, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", sessionCookie(session));
  headers.append("Set-Cookie", clearFlowCookie());
  return new Response(null, { status: 302, headers });
}

// ---------------------------------------------------------------- logout ----

// Local only. The IdP advertises no end_session endpoint — RP-initiated logout
// is not in the stage-3 cut — so this ends babylog's session and says nothing
// about the estate's. Signing out of auth.32b.io itself is done at its own
// account portal.
export function logout(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/app",
      "Set-Cookie": clearSessionCookie(),
      "Cache-Control": "no-store",
    },
  });
}
