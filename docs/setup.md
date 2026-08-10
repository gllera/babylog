# Setup & deployment

## 1. Install

```bash
npm install
```

## 2. Create the D1 database

```bash
npx wrangler d1 create baby-feedings
```

Copy the `database_id` from the output into `wrangler.jsonc`, replacing the
existing `database_id` (which belongs to the original deployment).

## 3. Apply the schema

```bash
# local (for `wrangler dev`)
npm run db:migrate:local

# production (after the database_id is set)
npm run db:migrate:remote
```

## 4. Run it locally

There is no IdP in front of `wrangler dev` and no session cookie to present, so
`.dev.vars` supplies the identity (**never set this variable in production**;
it is also ignored unless the request's host is `localhost`/`127.0.0.1`):

```
ALEXA_SKIP_SIGNATURE=true
DEV_USER_EMAIL=gabriellleragarcia@gmail.com   # the migration-seeded owner
```

```bash
npm run dev
# App: http://localhost:8787/app
```

`DEV_USER_EMAIL` opens the **browser** surfaces (`/app`, `/welcome`, `/api`).
It does **not** open `/mcp`, which since 2026-08-10 takes an access token and
nothing else (`src/mcp-auth.ts`) — there is no dev bypass on that gate, because
a bypass in the module whose entire job is refusing tokens is the one place it
must not exist. To poke at the MCP tools, point the Inspector at the deployed
endpoint and let it run the real OAuth flow:

```bash
npm run inspect
# Browser opens at http://localhost:5173 — point it at https://baby.32b.io/mcp
```

> `wrangler dev` does not hot-reload `.dev.vars` — restart it after editing.

## 5. Register the MCP resource at auth.32b.io

`/mcp` is an OAuth 2.1 protected resource with the identifier
`https://baby.32b.io/mcp` (`MCP_RESOURCE` in `src/mcp-auth.ts`), and nothing in
this repo has to be configured for it beyond `OIDC_ISSUER` — the tokens are
auth's. Two things must be true **at auth.32b.io**, and both are operator-only:

- tenant `32b` has dynamic client registration on, with
  `dcr_resources = ["https://baby.32b.io/mcp"]`. That list is the ceiling on
  what a self-registered client may name as its `resource`, so an MCP client
  that registers itself cannot ask for a token for anything else.
- the resource identifier is spelled identically at both ends. It is compared
  byte for byte: a trailing slash here is a token that verifies at auth and is
  refused at `/mcp`, with nothing in either half looking wrong on its own.

Keep `workers_dev: false` so the `*.workers.dev` origin stays shut.

## Retiring `baby.llera.eu`

The Worker side is done (2026-08-10): `/mcp` verifies its own tokens, and
`src/access.ts`, the Access branch of `src/identity.ts` and the
`TEAM_DOMAIN`/`POLICY_AUD` vars are deleted. The Cloudflare side is **not
performable from this repo** — the CI token is account-scoped and cannot touch
zone routes or Access — so it is the operator's, in this order:

1. Deploy the Worker.
2. Verify an MCP client completes the flow on `baby.32b.io`.
3. Delete the `baby-mcp` Access application.
4. Detach the `baby.llera.eu` custom domain from the Worker.
5. Delete the `baby.llera.eu` DNS record.

Steps 3–5 only after step 2 passes; doing them first turns a rollback into a DNS
change under pressure. Between the deploy and step 3, `baby.llera.eu` still
resolves and Access still fronts it — but the Worker no longer reads the header
Access stamps, so that hostname authenticates nobody.

The `baby-alexa` Access application is a different thing and **stays**: it is
path-scoped to `baby.32b.io/alexa` and is the only gate in front of `/alexa`.

## 6. Deploy

Pushes to `main` deploy automatically via GitHub Actions
(`.github/workflows/ci.yml`): typecheck + tests, then remote D1 migrations,
then `wrangler deploy`, then the Alexa interaction models. It needs a
`CLOUDFLARE_API_TOKEN` repo secret with **Workers Scripts: Edit** and **D1:
Edit** (plus `ASK_REFRESH_TOKEN` / `ASK_VENDOR_ID` for the Alexa job).

Don't also connect the repo to Cloudflare's own Git build (Workers Builds) —
that deploys every push a second time and never applies D1 migrations.

Manual deploy still works:

```bash
npm run db:migrate:remote && npm run deploy
```

## 32b.io OIDC auth

**Hostname live since 2026-07-30; OIDC client since 2026-08-01.**
`baby.32b.io` runs an OpenID Connect authorization-code + PKCE flow against
`https://auth.32b.io/t/32b` (`src/oidc.ts`) and mints its own
`__Host-bsess` session cookie (`src/session.ts`). The estate's shared
`Domain=32b.io` cookie — and the `SESSION_SECRET` that verified it — are
retired; nothing here reads them. Setup, in order:

1. **Register the client at auth.32b.io:** an application `babylog` in
   tenant `32b` (confidential, `redirect_uris` containing exactly
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

   Alexa account linking (`src/alexa-link.ts`) adds two more secrets, set the
   same way — see `alexa-skill/README.md` for the full flow:

   ```bash
   npx wrangler secret put ALEXA_OAUTH_HMAC_SECRET   # signs Alexa link tokens; distinct from SESSION_HMAC_SECRET
   npx wrangler secret put ALEXA_LINK_CLIENT_SECRET  # must equal the skill's Account Linking client secret
   ```

   plus the account-linking config pushed once via
   `ask-cli smapi update-account-linking-info` (Auth Code Grant, HTTP Basic,
   the `/auth/alexa/{authorize,token}` URLs) — **not** in CI, since it embeds
   the client secret and never changes; CI's `alexa-model` job pushes only the
   interaction models, a different SMAPI resource.
3. Deployed the code, then attached `baby.32b.io` as a Worker **custom
   domain** — *not* a `routes` entry in `wrangler.jsonc`:

   ```bash
   curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/domains" \
     -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
     -d '{"environment":"production","hostname":"baby.32b.io",
          "service":"baby-feeding-mcp","zone_id":"<32b.io zone id>"}'
   ```

   `baby.llera.eu` is attached the same way, and is being retired — see
   *Retiring baby.llera.eu* below. **Don't move either into
   `wrangler.jsonc`:** the CI token (`babylog-ci`) is account-scoped to
   Workers Scripts + D1 and has no zone permissions, so a declared custom
   domain would fail every CI deploy. Hostname changes are a deliberate
   out-of-band step with the full-access token. (Note the endpoint is `PUT`;
   `POST` returns error 10405.)

`/welcome` is the self-service onboarding entry (create a household or accept
a caregiver invite); invites live in the `invites` table (migration 0004).

Identity in the browser is `__Host-bsess` and nothing else (`src/identity.ts`).
It used to be the Access JWT first and the cookie second; the header is read by
nothing now, so there is no precedence left to get wrong.

> If `OIDC_CLIENT_SECRET` is unset or stale, `/auth/callback` fails the code
> exchange (auth.32b.io's `/token` rejects the client) — on login failures
> check that secret first. Rotating `SESSION_HMAC_SECRET` drops every
> baby.32b.io session; users just sign in again through auth.32b.io.

## Tests

```bash
npm test            # vitest unit tests (pure helpers in src/lib.ts, pickBaby)
npm run typecheck   # tsc --noEmit
```

Both run in CI (`.github/workflows/ci.yml`) on pushes to `main` and on PRs.

## Operational notes

- **Onboarding a new caregiver into the existing household is an invite +
  accept:** the owner invites from the web app's Settings tab or runs
  `add_caregiver`, creating a pending row in `invites`. The invitee then logs
  in and accepts on `/welcome`, turning the invite into a `users` row. Any
  auth.32b.io login reaches `/welcome`, so membership is purely DB state —
  there is no Access policy to edit for a new caregiver any more (there was,
  for as long as `baby.llera.eu` was a door). Starting a **separate** tenant is
  direct, not
  invite-based: `create_household` (MCP, arbitrary email) or the create form
  on `/welcome` (`createHouseholdForEmail`, always the caller's own email)
  registers the email immediately — no accept step.
- **D1 migrations are applied by CI** right before each deploy, so keep them
  additive (new tables/columns with sane defaults): the old Worker must
  tolerate the new schema for the seconds between the two steps.
- The Worker name in `wrangler.jsonc` is `baby-feeding-mcp` (the repo's original
  name). Renaming it would create a new Worker and orphan the routes, secrets,
  and Durable Object namespace, so it is intentionally left unchanged.
