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
