// -----------------------------------------------------------------------------
// Alexa account linking: the mini authorization server babylog fronts for
// exactly one client — Amazon.
//
// Why this exists at all: auth.32b.io's access tokens live 10 minutes and it
// issues no refresh tokens, while Alexa stores a token at link time and
// replays it for months. So babylog runs the OIDC login it already has
// (src/oidc.ts) to establish WHO, then wraps that identity in tokens it can
// verify locally — the same move as __Host-bsess, for a channel the IdP
// cannot serve. Identity never originates here.
//
// The HMAC secret is ALEXA_OAUTH_HMAC_SECRET, deliberately distinct from
// SESSION_HMAC_SECRET: rotating web sessions must never unlink every Echo,
// and unlinking Alexa must never sign the web out. The typ header is the
// wall between token kinds and is pinned on every verify.
// -----------------------------------------------------------------------------

import { SignJWT, jwtVerify } from "jose";
import { readSession } from "./session";
import type { Env } from "./types";

const ISSUER = "https://baby.32b.io";

type LinkEnv = Pick<
  Env,
  | "DB"
  | "SESSION_HMAC_SECRET"
  | "ALEXA_OAUTH_HMAC_SECRET"
  | "ALEXA_LINK_CLIENT_ID"
  | "ALEXA_LINK_CLIENT_SECRET"
  | "ALEXA_LINK_REDIRECTS"
>;

export const CODE_TYP = "alexacode+jwt";
export const ACCESS_TYP = "alexatk+jwt";
export const REFRESH_TYP = "alexart+jwt";

export type LinkTyp = typeof CODE_TYP | typeof ACCESS_TYP | typeof REFRESH_TYP;

export const CODE_TTL_S = 60;
export const ACCESS_TTL_S = 24 * 60 * 60;
// Amazon re-links only when refresh fails; make that a rare event.
export const REFRESH_TTL_S = 400 * 24 * 60 * 60;

export type LinkClaims = {
  sub: string;
  email: string;
  redirect_uri?: string;
  jti?: string;
};

const keyOf = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export async function mintLinkToken(
  env: Pick<Env, "ALEXA_OAUTH_HMAC_SECRET">,
  typ: LinkTyp,
  id: { sub: string; email: string },
  ttlSeconds: number,
  extra: Record<string, string> = {}
): Promise<string> {
  return new SignJWT({ email: id.email, ...extra })
    .setProtectedHeader({ alg: "HS256", typ })
    .setSubject(id.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(keyOf(env.ALEXA_OAUTH_HMAC_SECRET!));
}

export async function verifyLinkToken(
  env: Pick<Env, "ALEXA_OAUTH_HMAC_SECRET">,
  token: string,
  typ: LinkTyp
): Promise<LinkClaims | null> {
  if (!env.ALEXA_OAUTH_HMAC_SECRET) {
    console.log("ALEXA_OAUTH_HMAC_SECRET is not set — no Alexa link token can be verified");
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, keyOf(env.ALEXA_OAUTH_HMAC_SECRET), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      typ,
      requiredClaims: ["iss", "iat", "exp", "sub"],
    });
    if (typeof payload.email !== "string" || !payload.email) return null;
    return {
      sub: String(payload.sub),
      email: payload.email.toLowerCase(),
      redirect_uri:
        typeof payload.redirect_uri === "string" ? payload.redirect_uri : undefined,
      jti: typeof payload.jti === "string" ? payload.jti : undefined,
    };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- authorize --

const registeredRedirects = (env: LinkEnv): string[] =>
  (env.ALEXA_LINK_REDIRECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// A 302 that, unlike Response.redirect(), carries Cache-Control: no-store — the
// idiom src/oidc.ts uses for every sensitive redirect. A one-time code sitting
// in a cacheable Location header is a leak vector.
const seeOther = (location: string): Response =>
  new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );

// The minimal confirmation the user clicks to link. Its POST is what actually
// mints a code — see the CSRF note on handleAlexaAuthorize. redirect_uri/state
// are attacker-influenceable and go into HTML attributes, so escape them.
const confirmPage = (email: string, redirectUri: string, state: string, clientId: string): string =>
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link Alexa · babylog</title></head>
<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem">
<h1 style="font-size:1.25rem">Link Alexa to babylog</h1>
<p>Link your 32b.io account <strong>${escapeHtml(email)}</strong> to Alexa? Your Echo devices will be able to log feedings, diapers and routines for your household.</p>
<form method="POST" action="/auth/alexa/authorize">
<input type="hidden" name="response_type" value="code">
<input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
<input type="hidden" name="state" value="${escapeHtml(state)}">
<button type="submit" style="font-size:1rem;padding:.6rem 1.2rem">Link account</button>
</form>
</body></html>`;

// GET|POST /auth/alexa/authorize — Amazon sends the user's browser here to
// link. Client and redirect_uri are validated FIRST, against exact strings, on
// every request; a failure is a 400 with no Location header (RFC 6749
// §4.1.2.1 — never redirect an unvalidated URI). A wrong response_type goes
// back to Amazon as an OAuth error.
//
// A code is minted ONLY by the confirming POST, never by a GET. __Host-bsess is
// SameSite=Lax, still sent on a cross-site top-level GET navigation, so
// auto-approving on GET would let an attacker send a logged-in victim a crafted
// authorize link and have the victim's account bound to the attacker's Alexa
// device (account-linking CSRF). The GET renders a same-origin confirmation the
// user must POST; a forged cross-site POST carries no Lax cookie, so the click
// proves intent — no extra CSRF-token machinery. The IdP's consent governs
// scope (releasing the email), not the grant decision.
export async function handleAlexaAuthorize(request: Request, env: LinkEnv): Promise<Response> {
  const url = new URL(request.url);
  const isPost = request.method === "POST";
  const params = isPost ? new URLSearchParams(await request.text()) : url.searchParams;

  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state") ?? "";

  if (
    !env.ALEXA_LINK_CLIENT_ID ||
    clientId !== env.ALEXA_LINK_CLIENT_ID ||
    !registeredRedirects(env).includes(redirectUri)
  ) {
    return new Response("Unknown client or redirect_uri.", {
      status: 400,
      headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    });
  }

  const errorBack = (error: string): Response => {
    const to = new URL(redirectUri);
    to.searchParams.set("error", error);
    if (state) to.searchParams.set("state", state);
    return seeOther(to.toString());
  };

  if (params.get("response_type") !== "code") return errorBack("unsupported_response_type");

  const session = await readSession(request, env);
  if (!session) {
    // Sessionless GET, or a POST whose session expired mid-link: re-enter as a
    // top-level GET (login bounce → confirmation). Nothing is minted. Rebuild a
    // canonical GET URL so a POST's body params survive the round trip.
    const canonical = new URL(`${url.origin}/auth/alexa/authorize`);
    canonical.searchParams.set("response_type", "code");
    canonical.searchParams.set("client_id", clientId!);
    canonical.searchParams.set("redirect_uri", redirectUri);
    if (state) canonical.searchParams.set("state", state);
    const next = encodeURIComponent(canonical.pathname + canonical.search);
    return seeOther(`${url.origin}/auth/login?next=${next}`);
  }

  if (!isPost) {
    // Live session, GET: show the confirmation. The user must click to mint.
    return new Response(confirmPage(session.email, redirectUri, state, clientId!), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
      },
    });
  }

  // Live session, POST: the click happened, params re-validated above. Mint.
  const code = await mintLinkToken(env, CODE_TYP, session, CODE_TTL_S, {
    redirect_uri: redirectUri,
    jti: crypto.randomUUID(),
  });
  const to = new URL(redirectUri);
  to.searchParams.set("code", code);
  if (state) to.searchParams.set("state", state);
  return seeOther(to.toString());
}

// ------------------------------------------------------------------- token --

// Constant-time comparison. crypto.subtle.timingSafeEqual is a Workers
// extension vitest's Node runtime lacks, so XOR the bytes by hand; the length
// check short-circuits, which leaks only the length.
function secretsEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

const oauthError = (
  error: string,
  status: number,
  extraHeaders: Record<string, string> = {}
): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });

// The client's credentials, from HTTP Basic or the form body — the Alexa
// console offers both schemes, so both are accepted.
function clientAuth(request: Request, form: URLSearchParams): { id: string; secret: string } | null {
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Basic ")) {
    try {
      const [id, ...rest] = atob(header.slice(6)).split(":");
      return { id, secret: rest.join(":") };
    } catch {
      return null;
    }
  }
  const id = form.get("client_id");
  const secret = form.get("client_secret");
  return id && secret ? { id, secret } : null;
}

// POST /auth/alexa/token — Amazon redeems codes and refreshes tokens here,
// server-to-server. Every response is JSON with Cache-Control: no-store
// (RFC 6749 §5.1/§5.2).
export async function handleAlexaToken(request: Request, env: LinkEnv): Promise<Response> {
  const form = new URLSearchParams(await request.text());

  const creds = clientAuth(request, form);
  if (
    !creds ||
    !env.ALEXA_LINK_CLIENT_SECRET ||
    creds.id !== env.ALEXA_LINK_CLIENT_ID ||
    !secretsEqual(creds.secret, env.ALEXA_LINK_CLIENT_SECRET)
  ) {
    return oauthError("invalid_client", 401, {
      "WWW-Authenticate": 'Basic realm="https://baby.32b.io/auth/alexa/token"',
    });
  }

  const grant = form.get("grant_type");

  if (grant === "authorization_code") {
    const claims = await verifyLinkToken(env, form.get("code") ?? "", CODE_TYP);
    if (!claims || !claims.jti) return oauthError("invalid_grant", 400);
    // §4.1.3 substitution defence: the redemption names the same redirect_uri
    // the code was issued for.
    if (claims.redirect_uri !== form.get("redirect_uri")) {
      return oauthError("invalid_grant", 400);
    }
    // Single use: first redemption INSERTs the jti, a replay hits UNIQUE. Only
    // a genuine constraint violation is a replay (invalid_grant); any other D1
    // error is transient — the code was NOT recorded used, so surface it as
    // server_error and let Amazon retry rather than burning the user's consent
    // on a blip.
    try {
      await env.DB.prepare(
        "INSERT INTO alexa_link_codes (jti, used_at) VALUES (?, ?)"
      ).bind(claims.jti, Date.now()).run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/UNIQUE constraint failed/i.test(msg)) return oauthError("invalid_grant", 400);
      console.log(`alexa /token: marker insert failed (not a replay): ${msg}`);
      return oauthError("server_error", 500);
    }
    // Opportunistic purge; codes live 60s, so a day-old marker defends nothing.
    // Never let its failure sink a redemption that already succeeded.
    try {
      await env.DB.prepare("DELETE FROM alexa_link_codes WHERE used_at < ?")
        .bind(Date.now() - 86_400_000)
        .run();
    } catch (e) {
      console.log(
        `alexa /token: opportunistic purge failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    return tokenPair(env, claims);
  }

  if (grant === "refresh_token") {
    const claims = await verifyLinkToken(env, form.get("refresh_token") ?? "", REFRESH_TYP);
    if (!claims) return oauthError("invalid_grant", 400);
    // Rotation: a fresh pair every time. The old refresh token simply ages out
    // via its own exp — no reuse-detection state for a single confidential
    // client (the spec's explicit v1 scope).
    return tokenPair(env, claims);
  }

  return oauthError("unsupported_grant_type", 400);
}

async function tokenPair(env: LinkEnv, id: { sub: string; email: string }): Promise<Response> {
  return new Response(
    JSON.stringify({
      access_token: await mintLinkToken(env, ACCESS_TYP, id, ACCESS_TTL_S),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: await mintLinkToken(env, REFRESH_TYP, id, REFRESH_TTL_S),
    }),
    {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }
  );
}
