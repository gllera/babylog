# Verify the auth.32b.io integration, and remove what contradicts it

**Date:** 2026-08-09
**Status:** Approved
**Scope:** Sub-project 1 of 3 (verify → Alexa account linking → MCP OAuth).

## Why

babylog's web login has been a confidential OIDC client of
`https://auth.32b.io/t/t_32b` since 2026-08-01 (`src/oidc.ts`,
`src/session.ts`). Before building the next two integrations on top of it
(Alexa account linking and MCP OAuth, each with its own spec), confirm the
deployed reality matches what the repo claims — and delete the leftovers of
the schemes it replaced, which currently sit in the tree contradicting it.

## Audit — read-only, four checks

1. **Client registration.** Read-only `SELECT` against the shared D1 (via the
   `32b-auth` repo, its owner): the `babylog` application exists in tenant
   `t_32b`, `redirect_uris` contains exactly `https://baby.32b.io/auth/callback`,
   `id_token_signed_response_alg` is one the deploy signs (RS256 or EdDSA), and
   `code_ttl`/`id_token_ttl` sit inside auth's clamps (10–600 s / 60–86400 s).
2. **Worker secrets.** `wrangler secret list` for `baby-feeding-mcp` names
   `OIDC_CLIENT_SECRET` and `SESSION_HMAC_SECRET`. Names only — values are
   write-only and stay that way.
3. **Live flow probe.** `GET https://baby.32b.io/auth/login` responds 302 to
   `https://auth.32b.io/t/t_32b/authorize` with `client_id=babylog`, `state`,
   `nonce`, `code_challenge_method=S256`; the discovery document under the
   issuer resolves and its `jwks_uri` serves keys. No scripted full login — it
   needs a human, and auth's 15-minute cron canary already runs the whole dance.
4. **Deploy freshness.** The deployed Worker corresponds to `main` HEAD
   (CI deploys on every push to `main`).

## Cleanup

- **Delete `scripts/mint-sess.mjs`** (untracked). It mints the retired
  estate-wide `sess` format — `b64u(payload).b64u(sig)` HMAC over
  `{t:'sess', e:email}` — keyed by a `SESSION_SECRET` line that no longer
  exists in `.dev.vars`. Wrong scheme and wrong secret; a dev helper for a
  login that was deliberately deleted.
- **Fix `docs/setup.md`** (lines 83 and 113 area): it still instructs
  `wrangler secret put SESSION_SECRET` and says to keep it in sync with the
  www.32b.io Pages secret. That is exactly the estate-wide-forging-key
  confusion the `SESSION_HMAC_SECRET` rename exists to prevent. Rewrite those
  passages to the current setup: `SESSION_HMAC_SECRET` (per-Worker, shared
  with nothing) and `OIDC_CLIENT_SECRET` (registered at auth.32b.io).
- **Prune `.dev.vars`**: drop `ALEXA_CLIENT_SECRET`, referenced nowhere in
  `src/`. Local file, not committed — no repo diff.
- **Leave history alone.** Specs and plans under `docs/superpowers/` that
  mention `SESSION_SECRET` are records of past decisions, not instructions.

## Non-goals

No code changes to `src/`. No secret rotation. No touching the Alexa or MCP
auth surfaces — those are the next two sub-projects.

## Output

A findings report (pass/fail per audit check, with evidence) in the session,
and one commit carrying the `docs/setup.md` fix. If any audit check fails,
stop and report before fixing anything beyond the cleanup listed here.
