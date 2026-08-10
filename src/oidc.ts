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

// -----------------------------------------------------------------------------
// The "somebody just signed out here" marker.
//
// THE BUG IT EXISTS FOR. babylog's logout used to clear this session and land on
// /app, and say nothing to the IdP at all — the comment below it called that
// "local only" and treated it as a limitation of the stage-3 cut. It was not a
// limitation, it was a defect with a user-visible shape: the estate session at
// auth.32b.io survived every time, so the next /auth/login reached /authorize
// with a live session and got an authorization code for THE ACCOUNT THAT HAD
// JUST SIGNED OUT — no form, no email, no prompt. Signing out and back in
// silently returned the same person, and there was no way to reach a different
// one, because the IdP refuses `select_account` on purpose ("there is one
// session and no account picker", 32b-auth docs/oidc.md).
//
// Two halves fix it, because neither is sufficient alone:
//
//   - logout() now hands the browser to the IdP's own /logout page, which is
//     where the estate session can actually be ended. babylog cannot do that
//     itself: POST /auth/logout there is same-origin-checked precisely so no
//     other site can sign a visitor out, and babylog is another site. So it is
//     a link to a page with a button, and the button is a human action.
//   - Which is why the marker exists: that press CAN simply not happen. A user
//     who sees babylog's own signed-out screen and closes the tab has ended half
//     of it. The marker is babylog remembering the intent, so the next sign-in
//     sends `prompt=login` and the IdP re-authenticates whoever is at the
//     browser — which is where a different address gets typed.
//
// An hour: it covers "sign out, then sign in as somebody else" without turning
// every later visit into a forced email send for someone who has meanwhile
// signed in elsewhere on the estate and would rightly expect SSO. `?switch=1`
// is the same demand with no clock on it.
const BYE_COOKIE = "__Host-bbye";
const BYE_MAX_AGE_S = 60 * 60;

const byeCookie = (): string =>
  `${BYE_COOKIE}=1; Max-Age=${BYE_MAX_AGE_S}; Path=/; HttpOnly; Secure; SameSite=Lax`;

const clearByeCookie = (): string =>
  `${BYE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

// Presence only — the marker carries no value worth reading, and `__Host-` means
// no other estate host can have written it.
const hasCookie = (request: Request, name: string): boolean => {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return true;
  }
  return false;
};

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
//
// Both halves are exported because /mcp verifies auth's access tokens against
// the same published keys (src/mcp-auth.ts) and there must be ONE cache: a
// second copy would double the cold-start fetches and, worse, could be looking
// at a different generation of the key set during a rotation — one endpoint
// accepting what the other refuses is the kind of half-failure nobody
// reproduces.
const discoveryCache = new Map<string, Promise<Discovery>>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function discover(issuer: string): Promise<Discovery> {
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

export const jwks = (uri: string) => {
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

  // Two ways to demand a fresh authentication, and the difference is only who
  // asked: the marker is babylog remembering that this browser signed out here,
  // `switch=1` is the user saying so out loud from a link that still works after
  // the marker has expired.
  //
  // NOT sent on an ordinary sign-in, deliberately: `prompt=login` costs a whole
  // login ceremony — an email send on the magic-link path — every single time,
  // and a visitor arriving from another 32b.io product with a live estate
  // session is entitled to the SSO that estate exists to provide.
  const reauth = url.searchParams.get("switch") === "1" || hasCookie(request, BYE_COOKIE);

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
  if (reauth) authorize.searchParams.set("prompt", "login");

  // The marker is NOT cleared here. It is spent by a login that COMPLETES (see
  // handleCallback), so a demand the user abandoned halfway is still a demand
  // the next attempt makes — the same discipline the IdP applies to its own
  // re-authentication marker, which it clears when it issues a code rather than
  // when it asks.
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
  // The sign-out has been answered by a sign-in, so the demand it planted must
  // not outlive it and force a re-authentication on the next visit too.
  headers.append("Set-Cookie", clearByeCookie());
  return new Response(null, { status: 302, headers });
}

// ---------------------------------------------------------------- logout ----

// Ends babylog's session, then OFFERS to end the estate's.
//
// This used to be "local only", landing on /app and saying nothing to the IdP —
// described as a consequence of there being no end_session endpoint. That was
// the wrong conclusion from a true premise. There is no RP-initiated logout, so
// this cannot be one hop; but the IdP does have a /logout PAGE whose button ends
// the estate session, and linking to it is the whole difference between a logout
// that means something and one that leaves a live session behind for the next
// sign-in to walk straight back into. See the note on BYE_COOKIE above.
//
// It cannot be done without the redirect: that POST is same-origin-checked at
// the IdP so that no other site can sign a visitor out, and babylog is another
// site. And it cannot be done without the marker either, because the button is
// a human action that may never be pressed.
//
// The IdP's ORIGIN, not its issuer: `/logout` is served at the root, while
// OIDC_ISSUER carries a tenant path (`https://auth.32b.io/t/{tenant}`). Derived
// rather than hardcoded, for the same reason every endpoint here comes from
// discovery — although this one is not in the discovery document, since it is a
// page and not a protocol endpoint.
//
// `next` is validated at the IdP by its own safeNext, which bounds it to
// https://*.32b.io.
export function logout(request: Request, env: Env): Response {
  const origin = new URL(request.url).origin;
  const idp = new URL(env.OIDC_ISSUER!).origin;
  const headers = new Headers({
    Location: `${idp}/logout?next=${encodeURIComponent(`${origin}/app`)}`,
    "Cache-Control": "no-store",
  });
  // Appended, never a single "Set-Cookie" key in an object literal: the second
  // would silently replace the first, and the one that loses is the one nobody
  // notices.
  headers.append("Set-Cookie", clearSessionCookie());
  headers.append("Set-Cookie", byeCookie());
  return new Response(null, { status: 302, headers });
}
