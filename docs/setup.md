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

There is no Cloudflare Access in front of `wrangler dev`, so `.dev.vars`
supplies the identity (**never set this variable in production**):

```
ALEXA_SKIP_SIGNATURE=true
DEV_USER_EMAIL=gabriellleragarcia@gmail.com   # the migration-seeded owner
```

```bash
npm run dev
# MCP endpoint: http://localhost:8787/mcp
```

Open the MCP Inspector to poke at the tools:

```bash
npm run inspect
# Browser opens at http://localhost:5173 — point it at http://localhost:8787/mcp
```

> `wrangler dev` does not hot-reload `.dev.vars` — restart it after editing.

## 5. Configure Cloudflare Access

Create an Access application with Managed OAuth covering the Worker's custom
domain (Managed OAuth apps cannot be path-scoped, so it must cover the whole
host), allow your users' emails in its policy, and put the team domain + the
app's AUD tag into `wrangler.jsonc` → `vars` (`TEAM_DOMAIN`, `POLICY_AUD`).
Keep `workers_dev: false` so the unfronted `*.workers.dev` origin stays shut.

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
  in and accepts on `/welcome`, turning the invite into a `users` row. Which
  door they use decides who may reach `/welcome` at all: on `baby.32b.io` any
  32b.io magic-link login gets there, so membership is purely DB state; on
  `baby.llera.eu` their email must still pass the Access policy first. Point
  invitees at **`baby.32b.io`** — that is the self-service path, and it needs
  no Access edit. Starting a **separate** tenant is direct, not
  invite-based: `create_household` (MCP, arbitrary email) or the create form
  on `/welcome` (`createHouseholdForEmail`, always the caller's own email)
  registers the email immediately — no accept step.
- **D1 migrations are applied by CI** right before each deploy, so keep them
  additive (new tables/columns with sane defaults): the old Worker must
  tolerate the new schema for the seconds between the two steps.
- The Worker name in `wrangler.jsonc` is `baby-feeding-mcp` (the repo's original
  name). Renaming it would create a new Worker and orphan the routes, secrets,
  and Durable Object namespace, so it is intentionally left unchanged.
