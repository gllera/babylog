# babylog

A remote **Model Context Protocol** (MCP) server, deployed to **Cloudflare
Workers**, that records baby feedings and diapers (pee / poop / both).
Everything is stored in a **D1** database, scoped per household, so the same
history is visible to every caregiver and MCP client of that household.

**Auth:** **Cloudflare Access** (Managed OAuth) fronts the whole host. For
MCP clients, Access runs the entire OAuth 2.1 flow (discovery, dynamic client
registration, IdP login); browsers get the normal Access login. The Worker
verifies the `Cf-Access-Jwt-Assertion` header Access stamps (team JWKS +
issuer + AUD, `src/access.ts`) so no unfronted origin can slip through
(`workers_dev: false` keeps the `*.workers.dev` origin closed), and reads the
JWT's `email` claim as the user identity that all data is scoped to.

## Multi-user model

- A **household** is the tenancy unit: its caregivers all see and record the
  same data, and households never see each other's data.
- A **user** (email, as authenticated by Cloudflare Access) belongs to
  exactly one household.
- Each household has one or more **babies**; one of them is the *default*.
  Tools and API calls apply to the default baby unless a `baby` (name or id)
  says otherwise. The web app shows a baby switcher when a household has more
  than one baby.
- Every recorded event stores **who logged it** (`created_by`: the caregiver
  email, or `alexa` for voice entries).
- There is no self-serve signup: an authenticated email that is not
  registered gets a 403 until an existing user runs `add_caregiver` (join my
  household) or `create_household` (new isolated tenant). The email must
  also be allowed by the Access policy, which is managed in Cloudflare.
- The Alexa skill has no Access identity; its events go to the household in
  `ALEXA_HOUSEHOLD_ID` (default `1`) under that household's default baby.

## Tools exposed

All record / list / stats / indication tools accept an optional `baby`
(name or numeric id; default: the household's default baby).

| Tool                | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `set_profile`       | Update a baby's `name`, `sex`, `date_of_birth` (any combination); optional `baby` selector |
| `get_profile`       | List the household's babies with computed ages and the default marker   |
| `add_baby`          | Add a baby to the household (`name`, optional `sex` / `date_of_birth`)  |
| `set_default_baby`  | Change which baby tools target when `baby` is omitted                   |
| `add_caregiver`     | Register another email into the caller's household                      |
| `create_household`  | Create a new isolated household with its first caregiver + default baby |
| `record_feeding`    | Log a feeding: `amount_ml` (required), `when` (ISO ts). Returns the gap since the previous feeding |
| `list_feedings`     | List feedings, newest first. Optional `since` / `until` / `limit`       |
| `delete_feeding`    | Remove a feeding by `id`                                                |
| `record_diaper`     | Log a diaper: `kind` ('pee' / 'poop' / 'both'), `when`. Returns the gap since the previous diaper |
| `list_diapers`      | List diapers, newest first. Optional `since` / `until` / `kind` / `limit` |
| `delete_diaper`     | Remove a diaper event by `id`                                           |
| `record_routine`    | Log a routine event, medication, or supplement: `name` (e.g. 'Vitamin D', 'Bath'), `when`. Returns the gap since the previous entry with the same `name` |
| `list_routines`     | List entries, newest first. Optional `since` / `until` / `name` / `limit` |
| `delete_routine`    | Remove an entry by `id`                                                 |
| `record_note`       | Log a free-form note (e.g. 'pimples on face'): `text`, `when`           |
| `list_notes`        | List notes. Optional `since` / `until` / `search` / `limit`             |
| `delete_note`       | Remove a note by `id`                                                   |
| `record_weight`     | Log a weight in whole grams: `weight_g`, `when` (reports delta vs prev) |
| `list_weights`      | List weight measurements. Optional `since` / `until` / `limit`          |
| `delete_weight`     | Remove a weight measurement by `id`                                     |
| `record_height`     | Log a length/height in cm: `height_cm`, `when` (reports delta)          |
| `list_heights`      | List height measurements. Optional `since` / `until` / `limit`          |
| `delete_height`     | Remove a height measurement by `id`                                     |
| `add_indication`    | Define a target over an N-day window (e.g. '1 poop a day', 'bath every 2 days', 'max 4h between feedings'): `label`, `metric`, `target`, `comparison`, `period_days`, `filter`. `metric` ∈ `feeding_total_ml` / `feeding_count` / `feeding_gap_max_min` / `diaper_count` / `routine_count` / `note_count` |
| `list_indications`  | List defined indications (active by default)                            |
| `delete_indication` | Remove an indication by `id`                                            |
| `check_indications` | Evaluate all active indications against a day's actuals (today by default) |
| `get_stats`         | Feedings + diapers + routines + notes summary + latest weight & height. Pass `window` (`24h` / `today` / `7d` / `30d`) or custom `since`/`until` (default 24 h) |
| `record_many`       | Batch-record up to 20 events of mixed types (`feeding`, `diaper`, `routine`, `note`) in one call, with an optional shared `when`. All-or-nothing: if any event is invalid, nothing is recorded |

Timestamps are stored as ISO 8601 UTC strings (e.g. `2026-05-14T07:30:00Z`).
Inputs may also carry a timezone offset (e.g. `2026-05-14T09:30:00+02:00`);
the server normalizes them to UTC on write.
"Days" (for `check_indications` and `get_stats window='today'`) are
**Europe/Madrid** calendar days — the household timezone — consistent with
the Alexa skill's daily summary.

## Web UI

A browser-based view is served at `/app`. It lets you register, edit
(tap a list row), and remove feedings, diapers, routines, notes, weights,
and heights without an MCP client. **All times are Europe/Madrid** (the
household timezone, matching the MCP stats and the Alexa skill), never
the device timezone. The Today tab shows last-event cards, a "Today's targets"
card with live progress on every active indication, a merged
chronological diary of the day, and one-tap quick-record buttons (with
an Undo toast); the feeding quick-add amounts adapt to recent entries,
Vitamin D flips to a "done today" state once given, and an active
`feeding_gap_max_min` indication tints the Last feeding card when the
gap is exceeded. The Feeding and Diaper tabs add weekly charts with
day-comparison overlays, day-separator list grouping, and −10/+10
amount steppers; Weight and Height get growth trend charts with WHO
Child Growth Standards percentile bands (P3-P97, when the profile has
sex + birth date) plus the current percentile estimate, and the
dashboard cards show deltas vs the previous measurement. The Today data
comes from a single aggregated `/api/dashboard` request (which also
evaluates indications server-side over Madrid-day windows), refetched
whenever the app returns to the foreground. Households with more than
one baby get a switcher above the tabs; the selection persists and
scopes every view and quick-record. The UI follows the system
light/dark theme. The app is installable as a PWA (web manifest with
home-screen shortcuts, raster icons for iOS/Android, minimal
pass-through service worker). Authentication is the Cloudflare Access
login in front of the host — the app itself has no login screen.
Visiting `/` redirects to `/app`.

## Alexa skill

A Spanish (`es-ES`) custom Alexa skill lives in
[`alexa-skill/`](./alexa-skill/). The same Worker serves an Alexa endpoint
at `/alexa`, so voice commands ("*tomó 120 mililitros*", "*hizo caca*",
"*cómo vamos hoy*") write to the same D1 database as the MCP tools and the
web UI. See [`alexa-skill/README.md`](./alexa-skill/README.md) for setup.

## Setup

### 1. Install

```bash
npm install
```

### 2. Create the D1 database

```bash
npx wrangler d1 create baby-feedings
```

Copy the `database_id` from the output into `wrangler.jsonc`, replacing
the existing `database_id` (which belongs to the original deployment).

### 3. Apply the schema

```bash
# local (for `wrangler dev`)
npm run db:migrate:local

# production (after the database_id is set)
npm run db:migrate:remote
```

### 4. Run it locally

There is no Cloudflare Access in front of `wrangler dev`, so `.dev.vars`
supplies the identity (never set this variable in production):

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

### 5. Configure Cloudflare Access

Create an Access application with Managed OAuth covering the Worker's custom
domain (Managed OAuth apps cannot be path-scoped, so it must cover the whole
host), allow your users' emails in its policy, and put the team domain + the
app's AUD tag into `wrangler.jsonc` → `vars` (`TEAM_DOMAIN`, `POLICY_AUD`).
Keep `workers_dev: false` so the unfronted `*.workers.dev` origin stays shut.

### 6. Deploy

```bash
npm run deploy
```

## Connect from Claude

claude.ai → Connectors → add custom connector with the `/mcp` URL — the
browser runs the Access login on first connect (dynamic client registration,
no client id/secret). Claude Code:
`claude mcp add --transport http baby https://<your-host>/mcp`.

Then try:

> Record that the baby drank 120 ml at 7:30 this morning.
> Log a poopy diaper just now.
> She just peed and pooped, log it.
> How was the last 24 hours?

## Layout

```
.
├── src/
│   ├── index.ts                    # Router; verifies Access JWT, threads identity
│   ├── access.ts                   # Access JWT verification + email extraction
│   ├── users.ts                    # Tenancy: users → households → babies
│   ├── tools.ts                    # McpAgent (Durable Object) + MCP tools
│   ├── api.ts                      # JSON API for the web app (/api/*)
│   ├── web.ts                      # App shell serving + PWA assets
│   ├── app.html                    # Browser app shell (served at /app)
│   ├── icons.ts                    # PNG app icons (base64) for iOS/Android
│   ├── alexa.ts                    # /alexa endpoint for the Alexa skill
│   ├── lib.ts                      # Pure helpers (timezone, gaps, ages)
│   ├── types.ts                    # Env + DB row types
│   └── html.d.ts                   # Type shim: import *.html as string
├── test/
│   ├── lib.test.ts                 # Unit tests for the pure helpers
│   └── users.test.ts               # Unit tests for baby selection (pickBaby)
├── alexa-skill/
│   ├── interaction-model.es-ES.json  # Voice model to upload to Alexa
│   └── README.md                   # Step-by-step skill setup
├── migrations/                     # 0001..NNNN sequential D1 schema migrations
├── wrangler.jsonc                  # Worker + Durable Object + D1 + KV bindings
├── tsconfig.json
└── package.json
```

## Tests

```bash
npm test            # vitest unit tests (pure helpers in src/lib.ts)
npm run typecheck   # tsc --noEmit
```

Both run in CI (`.github/workflows/ci.yml`) on pushes to `main` and on PRs.

## Notes

- Onboarding a new caregiver takes two steps: allow their email in the
  Cloudflare Access policy, and run `add_caregiver` (same household) or
  `create_household` (separate tenant) from an MCP client. Until both are
  done they get the Access login but a 403 from the app.
- D1 migrations are applied manually (`npm run db:migrate:remote`), not by
  CI. Migration numbering jumps 0017 → 0020 because the production
  `d1_migrations` table already recorded 0018/0019 for a removed feature.
- The Durable Object is required by the MCP transport; persistent feeding
  data lives in D1 so it is shared across sessions and clients.
