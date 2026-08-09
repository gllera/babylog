# Auth Integration Verify (Audit + Cleanup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirm the live baby.32b.io ↔ auth.32b.io OIDC integration matches what the repo claims, and remove the three leftovers that contradict it.

**Architecture:** Four read-only audit probes (D1 client registration, Worker secrets, live authorize redirect + discovery, deploy freshness), then a cleanup pass: delete the dead `scripts/mint-sess.mjs`, rewrite the stale `docs/setup.md` session-auth section, prune `.dev.vars`. No `src/` changes.

**Tech Stack:** wrangler CLI (D1 + secrets), curl, gh CLI, git.

**Spec:** `docs/superpowers/specs/2026-08-09-auth-integration-verify-design.md`

---

### Task 1: Audit — client registration in the shared D1

The shared D1 belongs to 32b-auth (`database_name: 32b-auth`, binding `AUTH_DB`). Query it read-only from that repo's directory so wrangler picks up its config/auth.

**Files:** none (read-only).

- [ ] **Step 1: Run the registration query**

```bash
cd ~/ws/32b-auth && npx wrangler d1 execute 32b-auth --remote --json --command \
  "SELECT tenant_id, client_id, type, secret_hash IS NOT NULL AS has_secret, redirect_uris, id_token_signed_response_alg, code_ttl, id_token_ttl FROM applications WHERE client_id='babylog'"
```

Expected: exactly one row with `tenant_id: "t_32b"`, `type: "confidential"`, `has_secret: 1`, `redirect_uris` containing exactly `https://baby.32b.io/auth/callback`, `id_token_signed_response_alg` ∈ {RS256, EdDSA}, `code_ttl` in 10–600, `id_token_ttl` in 60–86400.

If wrangler cannot authenticate (no browser login on this box / token lacks D1 read), record the check as **blocked, not failed**, note the exact error, and continue — do not mint or widen any token to make it pass.

- [ ] **Step 2: Record the row (or the block) verbatim in the findings notes**

Keep a scratch findings file at `/tmp/claude-1000/-home-gllera-ws-babylog/19eb959c-7021-45f6-86f6-05e8102060f3/scratchpad/verify-findings.md`; append each check's evidence as you go. It feeds the final report and is never committed.

### Task 2: Audit — Worker secrets present

**Files:** none (read-only).

- [ ] **Step 1: List secrets on the deployed Worker**

```bash
cd ~/ws/babylog && npx wrangler secret list
```

Expected: JSON array whose names include `OIDC_CLIENT_SECRET` and `SESSION_HMAC_SECRET`. Flag as findings: either name missing, a lingering `SESSION_SECRET` or `SESSION_PUBLIC_JWK` (both retired), or any name the code never reads (cross-check against `Env` in `src/types.ts`).

- [ ] **Step 2: Append the name list to the findings notes**

### Task 3: Audit — live authorize redirect + discovery

**Files:** none (read-only).

- [ ] **Step 1: Probe /auth/login**

```bash
curl -sD - -o /dev/null https://baby.32b.io/auth/login
```

Expected: `HTTP/2 302` with `location: https://auth.32b.io/t/t_32b/authorize?...` carrying `client_id=babylog`, `redirect_uri=https%3A%2F%2Fbaby.32b.io%2Fauth%2Fcallback`, `response_type=code`, `code_challenge_method=S256`, non-empty `state`, `nonce` and `code_challenge`, plus a `set-cookie` for the transaction cookie. `scope` should be `openid email`.

- [ ] **Step 2: Probe discovery + JWKS**

```bash
curl -s https://auth.32b.io/t/t_32b/.well-known/openid-configuration | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['issuer']); print(d['jwks_uri']); print(d['token_endpoint'])"
curl -s "$(curl -s https://auth.32b.io/t/t_32b/.well-known/openid-configuration | python3 -c "import json,sys; print(json.load(sys.stdin)['jwks_uri'])")" | python3 -c "import json,sys; ks=json.load(sys.stdin)['keys']; print(len(ks), 'keys:', [k.get('alg') or k.get('kty') for k in ks])"
```

Expected: issuer exactly `https://auth.32b.io/t/t_32b` (this must equal `OIDC_ISSUER` in `wrangler.jsonc`), and ≥1 JWKS key covering the registered id_token alg. No full scripted login — auth's 15-minute cron canary already exercises the complete code+PKCE dance.

- [ ] **Step 3: Append both outputs to the findings notes**

### Task 4: Audit — deploy freshness

**Files:** none (read-only).

- [ ] **Step 1: Compare origin/main to the latest deploy run**

```bash
cd ~/ws/babylog && git fetch origin && git rev-parse origin/main && gh run list --branch main --limit 3
```

Expected: the most recent workflow run's commit is `origin/main` HEAD and its status is `completed success`. (Local HEAD is ahead by the spec/plan commits until this sub-project pushes — compare against `origin/main`, not HEAD.)

- [ ] **Step 2: Append run id, sha and status to the findings notes**

### Task 5: Cleanup — delete the dead script, prune .dev.vars

`scripts/mint-sess.mjs` (untracked) mints the retired estate-wide `sess` format keyed by a `SESSION_SECRET` line absent from `.dev.vars` — user approved deletion 2026-08-09. `ALEXA_CLIENT_SECRET` in `.dev.vars` is referenced nowhere in the repo (verified: whole-tree grep excluding node_modules matches only `.dev.vars` and the spec).

**Files:**
- Delete: `scripts/mint-sess.mjs` (and the then-empty `scripts/`)
- Modify: `.dev.vars` (local, gitignored — no repo diff)

- [ ] **Step 1: Delete the script**

```bash
cd ~/ws/babylog && rm scripts/mint-sess.mjs && rmdir scripts && git status --short
```

Expected: `git status --short` no longer shows `?? scripts/` (the file was never tracked, so no staged deletion appears — only the spec/plan work in progress).

- [ ] **Step 2: Remove the ALEXA_CLIENT_SECRET line from .dev.vars**

`.dev.vars` should go from:

```
ALEXA_SKIP_SIGNATURE=true
DEV_USER_EMAIL=gabriellleragarcia@gmail.com
ALEXA_CLIENT_SECRET=dev-alexa-client-secret-0123456789
```

to:

```
ALEXA_SKIP_SIGNATURE=true
DEV_USER_EMAIL=gabriellleragarcia@gmail.com
```

- [ ] **Step 3: Confirm nothing referenced it**

```bash
cd ~/ws/babylog && grep -rn "ALEXA_CLIENT_SECRET" src test alexa-skill .github 2>/dev/null; echo "refs: $?"
```

Expected: no matches (`refs: 1`).

### Task 6: Cleanup — rewrite the stale setup.md auth section

`docs/setup.md` lines 77–116 (“## 32b.io session auth”) still document the pre-2026-08-01 shared-cookie era: `wrangler secret put SESSION_SECRET` synced with www's Pages secret, `sess`-cookie verification, and the shared-secret redirect-loop warning. The custom-domain instructions inside it are still correct and load-bearing (`wrangler.jsonc` points at them) — keep them.

**Files:**
- Modify: `docs/setup.md:77-116`

- [ ] **Step 1: Replace the section**

Old text (the whole section from the `## 32b.io session auth` heading up to, but not including, `## Tests`):

````markdown
## 32b.io session auth

**Live since 2026-07-30.** `baby.32b.io` fronts the Worker with the shared
32b.io magic-link session (self-service onboarding), alongside the existing
`baby.llera.eu` + Access path. What was done, in this order:

1. **The secret first:** `npx wrangler secret put SESSION_SECRET`, using the
   same value as the www.32b.io Pages secret (a copy lives in
   `~/ws/32b/.dev.vars`). Always before the hostname exists — the Worker
   verifies the `sess` cookie with it (`src/session.ts`, `src/identity.ts`),
   and a live hostname without the secret is a redirect loop (see below).
2. Deployed the code, then attached `baby.32b.io` as a Worker **custom
   domain** — *not* a `routes` entry in `wrangler.jsonc`:

   ```bash
   curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/domains" \
     -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
     -d '{"environment":"production","hostname":"baby.32b.io",
          "service":"baby-feeding-mcp","zone_id":"<32b.io zone id>"}'
   ```

   `baby.llera.eu` is attached the same way. **Don't move either into
   `wrangler.jsonc`:** the CI token (`babylog-ci`) is account-scoped to
   Workers Scripts + D1 and has no zone permissions, so a declared custom
   domain would fail every CI deploy. Hostname changes are a deliberate
   out-of-band step with the full-access token. (Note the endpoint is `PUT`;
   `POST` returns error 10405.)

`/welcome` is the self-service onboarding entry (create a household or accept
a caregiver invite); invites live in the `invites` table (migration 0004).

Both hostnames now reach the same Worker and the same tenancy: identity is
Access JWT first, then the `sess` cookie (`src/identity.ts`). The `sess`
cookie is `Domain=32b.io`, so it is never sent to `baby.llera.eu` — the two
gates cannot shadow each other.

> If `SESSION_SECRET` is unset or differs from the www.32b.io Pages secret
> while a user holds a valid www session, baby.32b.io/app and the login page
> redirect each other in a loop — set the secret first, and on any loop check
> it first.
````

New text:

````markdown
## 32b.io OIDC auth

**Hostname live since 2026-07-30; OIDC client since 2026-08-01.**
`baby.32b.io` runs an OpenID Connect authorization-code + PKCE flow against
`https://auth.32b.io/t/t_32b` (`src/oidc.ts`) and mints its own
`__Host-bsess` session cookie (`src/session.ts`). The estate's shared
`Domain=32b.io` cookie — and the `SESSION_SECRET` that verified it — are
retired; nothing here reads them. Setup, in order:

1. **Register the client at auth.32b.io:** an application `babylog` in
   tenant `t_32b` (confidential, `redirect_uris` containing exactly
   `https://baby.32b.io/auth/callback`), via the tenant console at
   auth.32b.io. Registration mints the client secret. The non-secret half of
   the registration lives in `wrangler.jsonc` `vars` (`OIDC_ISSUER`,
   `OIDC_CLIENT_ID`) — deliberately in the file, since `wrangler deploy`
   overwrites dashboard vars.
2. **The secrets next**, always before the hostname exists:

   ```bash
   npx wrangler secret put OIDC_CLIENT_SECRET   # from step 1's registration
   npx wrangler secret put SESSION_HMAC_SECRET  # per-Worker random, e.g. openssl rand -base64 32
   ```

   `SESSION_HMAC_SECRET` is shared with nothing and forges only
   baby.32b.io sessions. It is deliberately **not** named `SESSION_SECRET`:
   that name means the retired estate-wide forging key, and the two must
   never be confusable (`src/session.ts` explains).
3. Deployed the code, then attached `baby.32b.io` as a Worker **custom
   domain** — *not* a `routes` entry in `wrangler.jsonc`:

   ```bash
   curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/domains" \
     -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
     -d '{"environment":"production","hostname":"baby.32b.io",
          "service":"baby-feeding-mcp","zone_id":"<32b.io zone id>"}'
   ```

   `baby.llera.eu` is attached the same way. **Don't move either into
   `wrangler.jsonc`:** the CI token (`babylog-ci`) is account-scoped to
   Workers Scripts + D1 and has no zone permissions, so a declared custom
   domain would fail every CI deploy. Hostname changes are a deliberate
   out-of-band step with the full-access token. (Note the endpoint is `PUT`;
   `POST` returns error 10405.)

`/welcome` is the self-service onboarding entry (create a household or accept
a caregiver invite); invites live in the `invites` table (migration 0004).

Both hostnames reach the same Worker and the same tenancy: identity is
Access JWT first, then `__Host-bsess` (`src/identity.ts`). The session
cookie is host-only by construction, so the two gates cannot shadow each
other.

> If `OIDC_CLIENT_SECRET` is unset or stale, `/auth/callback` fails the code
> exchange (auth.32b.io's `/token` rejects the client) — on login failures
> check that secret first. Rotating `SESSION_HMAC_SECRET` drops every
> baby.32b.io session; users just sign in again through auth.32b.io.
````

- [ ] **Step 2: Update the stale README auth paragraph**

`README.md:20-26` still says baby.32b.io "uses the shared 32b.io magic-link
session" — the same retired scheme. In `README.md`, replace:

```markdown
Authentication is dual during the llera.eu → 32b.io transition: `baby.32b.io`
uses the shared 32b.io magic-link session (self-service — new users create a
household or accept a caregiver invite at `/welcome`), while `baby.llera.eu`
stays behind Cloudflare Access (still fronting MCP and Alexa). The Worker
```

with:

```markdown
Authentication is dual during the llera.eu → 32b.io transition: `baby.32b.io`
signs users in through OpenID Connect at `auth.32b.io` and keeps its own
session (self-service — new users create a household or accept a caregiver
invite at `/welcome`), while `baby.llera.eu` stays behind Cloudflare Access
(still fronting MCP and Alexa). The Worker
```

(The rest of the paragraph is unchanged and stays.)

- [ ] **Step 3: Verify no stale references remain in current docs**

```bash
cd ~/ws/babylog && grep -rn "SESSION_SECRET\b" README.md docs/*.md src test | grep -v "SESSION_HMAC" | grep -v "retired\|deliberately\|estate-wide"
cd ~/ws/babylog && grep -rn "magic-link\|shared 32b.io" README.md docs/setup.md
```

Expected: no output from either (the remaining `SESSION_SECRET` mentions in `src/session.ts` and the new setup.md text are the deliberate this-is-retired warnings, filtered by the greps; `docs/superpowers/` history is untouched and not scanned).

### Task 7: Regression check + commit + report

**Files:** commit of `docs/setup.md` + `README.md` (the spec and this plan are already committed).

- [ ] **Step 1: Run the test suite and typecheck**

```bash
cd ~/ws/babylog && npm test && npm run typecheck
```

Expected: both pass (nothing in `src/` changed; this pins that).

- [ ] **Step 2: Commit**

```bash
cd ~/ws/babylog && git add docs/setup.md README.md && git commit -m "docs: the auth prose describes the OIDC client, not the retired shared cookie"
```

- [ ] **Step 3: Write the findings report**

Assemble `/tmp/claude-1000/-home-gllera-ws-babylog/19eb959c-7021-45f6-86f6-05e8102060f3/scratchpad/verify-findings.md` into the final session report: one line per audit check (pass/fail/blocked + evidence), the cleanup diff summary, and any finding that needs a follow-up decision. Do not push — pushing deploys, and the user decides when.
