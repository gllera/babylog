// -----------------------------------------------------------------------------
// /mcp as an OAuth 2.1 protected resource.
//
// It used to be a Cloudflare Access application's job. Access with Managed OAuth
// ran the ENTIRE flow for an MCP client — discovery, dynamic client
// registration, login — on baby.llera.eu, and this Worker only checked the
// `Cf-Access-Jwt-Assertion` header Access stamped on the way past. That worked,
// and it cost a second authorization server in front of one Worker: Cloudflare's
// for /mcp, auth.32b.io's for everything else. The llera.eu hostname could not
// be retired while it was the only thing that could log an MCP client in.
//
// Now auth.32b.io issues resource-bound tokens, so /mcp does what a protected
// resource does: it publishes WHERE its authorization server is (RFC 9728), and
// it verifies the tokens that server signs (RFC 9068). Nothing about the flow is
// configured in the client — a client with no token gets a 401 naming the
// metadata URL, reads the authorization server out of it, registers itself
// there, and comes back with a token.
//
// The keys come from auth's published jwks_uri, read out of the discovery
// document beneath the issuer, and both halves are src/oidc.ts's — the same
// per-isolate caches the browser login already fills. That is deliberate reuse
// and not convenience: a client holding its own copy of a signing key is exactly
// what cannot notice a rotation, which is why the pinned key that used to live
// in wrangler.jsonc is gone rather than repurposed.
// -----------------------------------------------------------------------------

import { jwtVerify, type JWTPayload } from "jose";
import { discover, jwks } from "./oidc";
import type { Env } from "./types";

// The canonical MCP server URL, and the ONE string everything below is derived
// from: the metadata paths, the metadata URL a 401 advertises, and the `aud`
// every access token must carry. It is also what an MCP client sends as
// `resource` at /authorize and what auth registers in the tenant's resource
// list, so a second spelling of it here would not be a duplicate constant — it
// would be a token that verifies at one end and is refused at the other.
export const MCP_RESOURCE = "https://baby.32b.io/mcp";

const WELL_KNOWN = "/.well-known/oauth-protected-resource";

// RFC 9728 §3.1 inserts the well-known segment BETWEEN the host and the
// resource's own path, so a resource at /mcp publishes at
// `/.well-known/oauth-protected-resource/mcp`. Both spellings answer, because
// the two halves of the ecosystem build different ones: an MCP client derives
// the path-suffixed form from the server URL it was given, while plenty of
// generic OAuth code asks for the bare path. A 404 at either is a client that
// never discovers the authorization server, and the document is the same
// document — there is nothing to gain by making a client guess right.
const METADATA_PATHS = [WELL_KNOWN, `${WELL_KNOWN}${new URL(MCP_RESOURCE).pathname}`];

const METADATA_URL = `${new URL(MCP_RESOURCE).origin}${WELL_KNOWN}`;

// -------------------------------------------------------------- refusals ----

// Every challenge parameter is a FIXED string chosen here, never anything that
// arrived in the request. `WWW-Authenticate` is a quoted-string grammar: one
// quote from an attacker-controlled value ends the string and everything after
// it is a parameter of their choosing. There is nothing about a failed token
// worth telling its bearer anyway — they hold it, they can read it.
const deny = (status: number, body: string, params: Record<string, string>): Response =>
  new Response(body, {
    status,
    headers: {
      "WWW-Authenticate": `Bearer ${Object.entries({ ...params, resource_metadata: METADATA_URL })
        .map(([k, v]) => `${k}="${v}"`)
        .join(", ")}`,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

// No credential was presented, so there is no `error` — RFC 6750 §3 wants one
// only for a credential that FAILED. The distinction is the client's: this is
// "go and get a token", the one below is "the token you have is no good".
const noCredential = (): Response => deny(401, "Unauthorized", {});

// ...and this one is what tells a client with an expired token to REFRESH
// rather than to run dynamic client registration again from scratch.
const invalidToken = (): Response =>
  deny(401, "Unauthorized", {
    error: "invalid_token",
    error_description:
      "The access token is expired, malformed, or was not issued for this resource.",
  });

// ---------------------------------------------------------------- the gate --

export type McpAuth = { ok: true; email: string } | { ok: false; response: Response };

export async function authorizeMcp(request: Request, env: Env): Promise<McpAuth> {
  // `header` is the only bearer method this resource advertises, so it is the
  // only one it reads. A token in a query string is a credential in every log
  // and every Referer between the client and here, and RFC 6750 §2.3 already
  // deprecates the form-encoded body.
  const presented = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("Authorization") ?? "");
  if (!presented) return { ok: false, response: noCredential() };

  if (!env.OIDC_ISSUER) {
    // Nothing is behind this: an unset issuer refuses every token on the
    // Worker. Name it, or the symptom reads as an authorization server that
    // suddenly mints tokens nobody accepts.
    console.log("OIDC_ISSUER is not set — no MCP access token can be verified");
    return { ok: false, response: invalidToken() };
  }

  // Five checks, and all of them are mandatory:
  //
  //   signature  against the keys auth PUBLISHES, fetched from the jwks_uri in
  //              its own discovery document.
  //   iss        exactly the configured issuer. The tenant segment is part of
  //              it: another tenant's provider is a different provider,
  //              whatever it signed.
  //   aud        exactly this resource. THIS IS THE ONE that turns the file
  //              from "we trust anything auth signed" into a resource server.
  //              auth's own access tokens for /userinfo carry the issuer as
  //              their audience, are signed by the same key, and name the same
  //              subject — and this check is the entire reason one of them
  //              cannot read a household's diary. /userinfo performs the mirror
  //              check, so neither token opens the other's door.
  //   typ        `at+jwt`, RFC 9068. A signature check says who minted a token,
  //              never WHICH KIND it minted, and this application's id_token is
  //              one rename away from carrying an `aud` that matches.
  //   exp / iat  current, and required rather than optional — jose ignores an
  //              absent `exp` unless it is asked for one, which is the quiet
  //              way to accept a token that never expires.
  let claims: JWTPayload;
  try {
    const doc = await discover(env.OIDC_ISSUER);
    ({ payload: claims } = await jwtVerify(presented[1], jwks(doc.jwks_uri), {
      issuer: env.OIDC_ISSUER,
      audience: MCP_RESOURCE,
      typ: "at+jwt",
      requiredClaims: ["iss", "aud", "sub", "exp", "iat"],
    }));
  } catch {
    // Including a discovery or JWKS fetch that failed. An unverifiable token is
    // not a token, whatever the reason, and the client's move is the same one.
    return { ok: false, response: invalidToken() };
  }

  // Lowercased, exactly as getIdentityEmail produces it: households key on the
  // address (resolveTenant) and every MCP tool scopes its data by it.
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  if (!email) {
    // 403 and not 401, because nothing is wrong with the token — a client told
    // to get another one would get another one just like it. It is this product
    // that has no other name for a person, so the fix is a scope, and the
    // refusal says which. The user-visible consequence is real and intended:
    // decline `email` at auth's consent screen and the MCP server is closed to
    // you. Keying on `sub` instead is more robust and survives an address
    // change, and it is a D1 migration plus a backfill — deliberately deferred,
    // because it is not what stands between here and a working /mcp.
    return {
      ok: false,
      response: deny(403, "Forbidden", {
        error: "insufficient_scope",
        error_description:
          "This access token carries no email claim. Re-authorize with the email scope.",
        scope: "openid email",
      }),
    };
  }
  return { ok: true, email };
}

// ------------------------------------------------------------- discovery ----

// The document that makes the 401 above useful. Null for any other path, so the
// router can ask about a URL rather than repeating the two paths at the call
// site — where a third spelling could quietly appear.
export function protectedResourceMetadata(url: URL, env: Env): Response | null {
  if (!METADATA_PATHS.includes(url.pathname)) return null;
  return new Response(
    JSON.stringify({
      resource: MCP_RESOURCE,
      // The SAME string authorizeMcp checks `iss` against, and derived rather
      // than restated for that reason: two copies drift in the one direction
      // that is not a compile error — clients are sent to an authorization
      // server whose tokens are then refused here, with nothing in either half
      // looking wrong on its own.
      // An empty list rather than a `!`: the binding is optional in Env, and a
      // document naming `null` as an authorization server is one a client
      // parses, believes, and fails on somewhere further in. Empty says the
      // true thing — this deploy has no authorization server configured — and
      // matches authorizeMcp, which refuses every token in that state.
      authorization_servers: env.OIDC_ISSUER ? [env.OIDC_ISSUER] : [],
      // Header only. See the note in authorizeMcp.
      bearer_methods_supported: ["header"],
      // `offline_access` is what a client asks for to be given a refresh token,
      // and it is advertised ahead of auth serving it on purpose: OIDC Core §5.4
      // makes an unknown scope value something the authorization server IGNORES
      // rather than an error, so a client that asks early simply does not get a
      // refresh token and has to log in again. The alternative — waiting, then
      // editing this list — is a second deploy on the day refresh tokens land,
      // in the one repo that is not the one they land in.
      scopes_supported: ["openid", "email", "offline_access"],
    }),
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        // Static per deploy, and every MCP client reads it before its first
        // request. There is nothing per-user in it to leak into a shared cache.
        "Cache-Control": "public, max-age=3600",
      },
    }
  );
}
