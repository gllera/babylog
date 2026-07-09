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

## Tests

```bash
npm test            # vitest unit tests (pure helpers in src/lib.ts, pickBaby)
npm run typecheck   # tsc --noEmit
```

Both run in CI (`.github/workflows/ci.yml`) on pushes to `main` and on PRs.

## Operational notes

- **Onboarding a new caregiver takes two steps:** allow their email in the
  Cloudflare Access policy, and register them — invite from the web app's
  Settings tab or run `add_caregiver` (same household) or `create_household`
  (separate tenant) from an MCP client. Until both are done they get the
  Access login but a 403 from the app.
- **D1 migrations are applied by CI** right before each deploy, so keep them
  additive (new tables/columns with sane defaults): the old Worker must
  tolerate the new schema for the seconds between the two steps.
- The Worker name in `wrangler.jsonc` is `baby-feeding-mcp` (the repo's original
  name). Renaming it would create a new Worker and orphan the routes, secrets,
  and Durable Object namespace, so it is intentionally left unchanged.
