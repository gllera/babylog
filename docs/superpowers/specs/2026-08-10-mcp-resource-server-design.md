# `/mcp` becomes a resource server, and `baby.llera.eu` retires

**Date:** 2026-08-10
**Status:** approved, not started
**Depends on:** `~/ws/32b-auth/docs/superpowers/specs/2026-08-10-non-confidential-clients-design.md`
stages **A** (resource indicators) and **C** (refresh tokens). Stage **D** (dynamic
client registration) is what makes this work with MCP clients that cannot be
pre-registered; without it only a pre-registered client reaches `/mcp`.

## Problem

`/mcp` is the last thing holding `baby.llera.eu` alive.

Everything else on this Worker moved to `baby.32b.io` and its own OIDC session
(`src/oidc.ts`, `src/session.ts`). `/mcp` did not, because it never had a login
of its own: `src/index.ts:36` describes the arrangement honestly — Cloudflare
Access with Managed OAuth *"runs the entire OAuth 2.1 flow for the MCP client
(discovery, dynamic client registration, login)"*, and the Worker only verifies
the `Cf-Access-Jwt-Assertion` header Access stamps on the way past.

So there are two authorization servers in front of one Worker: Cloudflare's, for
`/mcp` on llera.eu, and auth.32b.io's, for everything else. The llera.eu one
cannot be deleted while it is the only thing that can log an MCP client in.

Once auth.32b.io serves public clients with resource-bound tokens, it can. `/mcp`
stops being a thing Access protects and becomes an ordinary OAuth 2.1 protected
resource: it publishes where its authorization server is, and it verifies the
tokens that server signs.

## Design

### The resource identifier

```
https://baby.32b.io/mcp
```

The canonical MCP server URL, which is what the MCP authorization spec uses and
what gets registered in the tenant's DCR resource list at auth. It is the value
an MCP client sends as `resource` at `/authorize`, and the value that arrives as
`aud` in the access token.

### Protected resource metadata (RFC 9728)

Two paths, both static JSON, both cacheable:

```
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
```

The second is the path-suffixed form — MCP clients derive it from the server URL's
path, and a client that only knows how to build that one must not 404. Both
answer the same document:

```json
{
  "resource": "https://baby.32b.io/mcp",
  "authorization_servers": ["https://auth.32b.io/t/32b"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["openid", "email", "offline_access"]
}
```

`header` only. A bearer token in a query string is a credential in every log and
Referer between the client and here, and RFC 6750 §2.3 already deprecates the
form-encoded body.

### The 401 that starts a login

An unauthenticated request to `/mcp` answers:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://baby.32b.io/.well-known/oauth-protected-resource"
```

That header is the entire discovery path. An MCP client with no token gets this
401, reads the metadata URL out of it, learns which authorization server to go
to, registers itself there, and comes back with a token. Nothing about the flow
is configured in the client; every hop is discovered.

The same header, with `error="invalid_token"` and a description, answers a
request whose token failed verification — RFC 6750 §3 — so a client with an
expired token knows to refresh rather than to re-register.

### Verification

A new `src/mcp-auth.ts`, verifying the bearer JWT against **the keys auth
publishes**, not against anything configured here. `src/oidc.ts` already has both
halves cached per isolate — `discovery(issuer)` and `jwks(uri)` — and they are
reused rather than re-implemented, for the reason `wrangler.jsonc` gives about
the pinned key that used to live in this repo: a client holding its own copy of a
signing key is exactly what cannot notice a rotation.

Five checks, all of which must pass:

| Check | Value | Why |
|---|---|---|
| signature | auth's JWKS, via `jwks_uri` in its discovery document | |
| `iss` | `env.OIDC_ISSUER` exactly | The tenant segment is load-bearing |
| `aud` | `https://baby.32b.io/mcp` exactly | **The whole point.** A `/userinfo` token, or a token minted for another resource, is refused here |
| `typ` header | `at+jwt` | RFC 9068. An id_token is not an access token, and a signature check alone does not say which is which |
| `exp` / `iat` | current | |

The `aud` check is the one that turns this from "we trust anything auth signed"
into a resource server. auth's `/userinfo` performs the mirror check, so neither
token opens the other's door.

### Identity

`email`, lowercased, exactly as `getIdentityEmail` produces today — babylog's
households key on it (`resolveTenant`), and every MCP tool already scopes its
data by it through `ctx.props.email`.

A token **without** an `email` claim is refused with `403` and a description
naming the missing scope, rather than being allowed through as an anonymous
session. That is a real user-visible consequence and it belongs in the docs: a
user who declines the `email` scope at auth's consent screen cannot use the MCP
server, because babylog has no other name for them.

Keying on `sub` instead was considered and deliberately deferred — it is more
robust and survives an email change, but it is a D1 migration plus a backfill in
this repo, and it is not what stands between here and a working `/mcp`.

### What this deletes

- **`src/access.ts`** — the whole file. Cloudflare Access JWT verification has no
  caller once `/mcp` verifies its own tokens.
- **The Access branch of `src/identity.ts`**, leaving the session cookie and the
  `DEV_USER_EMAIL` dev fallback. The header-order comment goes with it: there is
  no outer gate to win any more.
- **`TEAM_DOMAIN` and `POLICY_AUD`** from `wrangler.jsonc`.
- **The host gate on the logout button** in `src/app.html` — `location.hostname === "baby.32b.io"`
  exists only because llera.eu had no session of its own to end.
- **`SERVER_ORIGIN`** moves from `https://baby.llera.eu` to `https://baby.32b.io`
  (`src/web.ts:9`, read by `src/tools.ts` for the MCP server's advertised icon and
  website).

### Cloudflare-side retirement

Not performable from this repo — the CI token is account-scoped and cannot touch
zone routes or Access. Left for the operator, in this order:

1. Deploy the Worker with `/mcp` self-authenticating. **Both hostnames work at
   this point**, so nothing is racing.
2. Verify an MCP client can complete the flow on `baby.32b.io`.
3. Delete the `baby-mcp` Access application.
4. Detach the `baby.llera.eu` custom domain from the Worker.
5. Delete the `baby.llera.eu` DNS record.

Steps 3–5 only after step 2 passes. Doing them first turns a rollback into a DNS
change under pressure.

## Testing

1. **The audience wall.** A token minted for auth's own issuer — the kind
   `/userinfo` takes — is refused at `/mcp`. This is the test that fails if
   somebody later "simplifies" the check to "signed by auth".
2. **The `typ` wall.** An id_token for the same subject, with the right `iss` and
   an `aud` that happens to match, is refused.
3. **The 401 contract.** No token → 401 carrying a `WWW-Authenticate` header
   whose `resource_metadata` URL fetches successfully and names this resource.
4. **Metadata at both paths**, byte-identical.
5. **No email claim** → 403, not 401 and not a session.

## Sequencing

1. `src/mcp-auth.ts` plus the two metadata routes and the 401 — additive, and
   `/mcp` still accepts the Access JWT at this point, so both paths work.
2. Verify against auth's staging tenant, then live.
3. Delete `src/access.ts`, the identity branch, the two vars, the host gate; move
   `SERVER_ORIGIN`.
4. Hand the operator the Cloudflare steps.

## Not doing

- **No MCP-specific scope.** One resource, all-or-nothing. Mirrors the decision on
  the auth side.
- **No token caching or introspection.** The JWT is self-validating; auth's
  `/introspect` exists but nothing here needs it.
- **No change to the Alexa mini-AS.** `src/alexa-link.ts` stays exactly as it is:
  Amazon's account-linking contract is fixed and external, and it is not an MCP
  client. This design does not make it one.
