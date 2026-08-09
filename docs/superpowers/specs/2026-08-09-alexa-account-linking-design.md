# Alexa account linking — auth.32b.io identity through a babylog mini-AS

**Date:** 2026-08-09
**Status:** Approved
**Scope:** Sub-project 2 of 3 (verify → **Alexa** → MCP OAuth).

## Why

Every Alexa request today maps to the pinned `ALEXA_HOUSEHOLD_ID` — no
per-user credential at all. The goal is Alexa users logging in with their
32b.io account. Pointing Alexa's account linking directly at auth.32b.io is
not viable: its access tokens live 10 minutes and it issues no refresh tokens
(deliberately, for now), so every link would die minutes after it was made —
and even a future direct link would pay a `/userinfo` network hop per
utterance. Instead babylog fronts a **mini authorization server** for exactly
one client (Amazon): identity still comes exclusively from the existing
auth.32b.io OIDC login, babylog only re-wraps it in tokens it can verify
locally — the same pattern as `__Host-bsess`, for a channel the IdP cannot
serve. **Strict mode** (user decision 2026-08-09): unlinked devices get a
link prompt, and `ALEXA_HOUSEHOLD_ID` is deleted.

## Endpoints

Both live under the already-public `/auth/` prefix — the `baby-alexa` Access
app gates the `/alexa` path only (verified: unsigned POST to
`baby.32b.io/alexa` → Access 403, while `/auth/login` serves 302s). Amazon
must reach `/auth/alexa/token` server-to-server, so neither endpoint may ever
move behind Access.

### `GET /auth/alexa/authorize`

Params: `response_type=code`, `client_id`, `redirect_uri`, `state`
(`scope` accepted and ignored).

1. `client_id` must equal `ALEXA_LINK_CLIENT_ID` (a `wrangler.jsonc` var —
   client ids are not secrets) and `redirect_uri` must exact-string-match one
   of `ALEXA_LINK_REDIRECTS` (var, comma-separated: the vendor-specific
   `https://pitangui.amazon.com/api/skill/link/…`,
   `https://layla.amazon.com/api/skill/link/…`,
   `https://alexa.amazon.co.jp/api/skill/link/…` URLs shown in the skill
   console). Unknown client or unregistered redirect → **400, no `Location`
   header** (RFC 6749 §4.1.2.1 — never redirect an unvalidated URI; same
   discipline as auth.32b.io).
2. No `__Host-bsess` session → 302 to
   `/auth/login?next=<urlencoded full authorize URL>`. `safeNext` already
   admits any same-host path, so the round trip needs no login changes.
3. With a session: **auto-approve** — the AS and the product are the same
   thing, and the IdP's consent already governed the email release. Mint a
   code, 302 to `redirect_uri` with `code` + the caller's `state`.

### `POST /auth/alexa/token`

Client auth: HTTP Basic **or** `client_id`/`client_secret` body params (the
Alexa console offers both; support both). Secret compared against
`ALEXA_LINK_CLIENT_SECRET` (Worker secret) in constant time.

- `grant_type=authorization_code`: verify the code JWT (sig, `typ`, `exp`),
  check its embedded `redirect_uri` equals the request's (§4.1.3
  substitution defence), enforce single use, return the token pair.
- `grant_type=refresh_token`: verify the refresh JWT, return a **new** pair
  (rotation — Alexa stores the new refresh token; the old one simply ages
  out via its own `exp`, no reuse-detection state in v1: the only client is
  a confidential Amazon).
- Errors per RFC 6749 §5.2: `invalid_client` → 401 +
  `WWW-Authenticate: Basic`, `invalid_grant`, `unsupported_grant_type`;
  JSON bodies, `Cache-Control: no-store`.

## Codes and tokens

All HMAC-SHA256 JWTs signed with a **new secret `ALEXA_OAUTH_HMAC_SECRET`** —
deliberately not `SESSION_HMAC_SECRET`: rotating web sessions must never
unlink every Echo, and unlinking Alexa must never sign the web out. Issuer
`https://baby.32b.io` everywhere; the `typ` header is the wall between token
kinds and is always pinned on verify:

| Kind | `typ` | TTL | Claims |
| --- | --- | --- | --- |
| code | `alexacode+jwt` | 60 s | `sub`, `email`, `redirect_uri`, `jti` |
| access | `alexatk+jwt` | 24 h | `sub`, `email` |
| refresh | `alexart+jwt` | 400 d | `sub`, `email` |

`sub`/`email` are whatever the OIDC login established (`u_<ULID>` account id
and verified address from tenant `t_32b`, `subject_type: public`).

**Single-use codes:** a new table in babylog's **own** D1 (additive
migration, CI applies it before the Worker deploys):

```sql
CREATE TABLE alexa_link_codes (
  jti      TEXT PRIMARY KEY,
  used_at  INTEGER NOT NULL
);
```

`/token` INSERTs the code's `jti`; a conflict means replay → `invalid_grant`.
Rows older than a day are deleted opportunistically on the same request path
(codes expire in 60 s, so the table stays tiny).

## Per-utterance identity (strict)

In `src/alexa.ts`, after the existing signature/application-id gate:

1. Read `context.System.user.accessToken` (fallback
   `session.user.accessToken`).
2. Verify locally: HMAC sig, `typ: "alexatk+jwt"`, issuer, expiry. No
   network hop — voice latency is unchanged.
3. Map `email` → `users` row → household, replacing the
   `ALEXA_HOUSEHOLD_ID` lookup everywhere it is read.
4. Missing/invalid/expired token → localized speech
   ("link your account in the Alexa app" / es-ES equivalent) + a
   `card: { type: "LinkAccount" }` response, `shouldEndSession: true`.
5. Linked email with **no `users` row** → the no-silent-provisioning
   invariant holds: localized "your account isn't in a household yet —
   accept your invite at baby.32b.io", session ends.

`ALEXA_HOUSEHOLD_ID` is **deleted** from `Env`/`AlexaEnv` types and from
`src/alexa.ts` parsing. Nothing is deployed under that name (verified
2026-08-09: `wrangler secret list` doesn't show it — production has always
ridden the code default `"1"`), so the deletion is purely code-side. New
speech lines live in `src/alexa-i18n.ts` for es-ES and en.

## Config & ops (out of band, not CI)

- Secrets first: `wrangler secret put ALEXA_OAUTH_HMAC_SECRET` and
  `ALEXA_LINK_CLIENT_SECRET` (both `openssl rand -base64 32`), before the
  code that reads them deploys.
- Vars in `wrangler.jsonc`: `ALEXA_LINK_CLIENT_ID`, `ALEXA_LINK_REDIRECTS`.
- Account linking config pushed once via SMAPI
  (`ask-cli smapi update-account-linking-info`, Auth Code Grant, the two
  URLs, client id/secret, HTTP Basic) using the same local `ask-cli`
  credentials CI holds — but **not in CI**: it embeds the client secret and
  never changes. CI's `alexa-model` job pushes interaction models only, a
  different SMAPI resource — it cannot clobber this.
- Lambda and interaction models: untouched.

## Testing

Unit (vitest, alongside the existing suites):

- authorize: bad client/redirect → 400 without `Location`; no session → 302
  into `/auth/login` with `next` round-tripping; with session → 302 to
  Amazon with `code`+`state`.
- token: both client-auth schemes; wrong secret → 401 `invalid_client` +
  `WWW-Authenticate`; code replay → `invalid_grant`; redirect_uri
  substitution → `invalid_grant`; refresh rotation returns a fresh pair.
- identity: linked happy path writes to the linked household; no token →
  `LinkAccount` card, ES and EN speech; unknown email → invite line.
- The `typ` wall, pinned from both sides: an `alexatk+jwt` never
  authenticates `/app` (session verifier rejects it), and `__Host-bsess`
  never authenticates `/alexa` (token verifier rejects it) — the
  `test/session.test.ts` pattern.

Live, after deploy + SMAPI config: link from the Alexa app (runs the real
auth.32b.io login), one utterance end-to-end, check the entry in `/app`,
then unlink/relink while watching `wrangler tail`.

## Non-goals

No PKCE (Alexa's account-linking client doesn't send it; the client is
confidential). No consent screen. No reuse-detection state for refresh
tokens in v1. No Lambda changes. No MCP changes — that is sub-project 3.
