# Architecture

babylog is a single **Cloudflare Worker**, deployed against one **D1** (SQLite)
database, that exposes three interfaces over the same data:

- **MCP** at `/mcp` — the Model Context Protocol server ([tool reference](./mcp-tools.md))
- **Web app** at `/app` — a browser UI ([details](./web-ui.md))
- **Alexa** at `/alexa` — a Spanish voice skill ([setup](../alexa-skill/README.md))

All three read and write the same per-household data, so an event logged by
voice shows up in the web app and is queryable over MCP.

## Authentication

**Cloudflare Access** (Managed OAuth) fronts the whole host. For MCP clients,
Access runs the entire OAuth 2.1 flow (discovery, dynamic client registration,
IdP login); browsers get the normal Access login. The Worker verifies the
`Cf-Access-Jwt-Assertion` header Access stamps (team JWKS + issuer + AUD,
`src/access.ts`) so no unfronted origin can slip through — `workers_dev: false`
keeps the `*.workers.dev` origin closed — and reads the JWT's `email` claim as
the user identity that all data is scoped to.

The Alexa endpoint has no Access identity (it is reached through an AWS Lambda,
not a browser). Its events are attributed to a fixed `alexa` identity and go to
the household in `ALEXA_HOUSEHOLD_ID` (default `1`).

## Multi-user model

- A **household** is the tenancy unit: its caregivers all see and record the
  same data, and households never see each other's data.
- A **user** (email, as authenticated by Cloudflare Access) belongs to exactly
  one household.
- Each household has one or more **babies**; one of them is the *default*.
  Tools and API calls apply to the default baby unless a `baby` (name or id)
  says otherwise. The web app shows a baby switcher when a household has more
  than one baby.
- Every recorded event stores **who logged it** (`created_by`: the caregiver
  email, or `alexa` for voice entries).
- There is **no self-serve signup**: an authenticated email that is not
  registered gets a 403 until an existing user runs `add_caregiver` (join my
  household) or `create_household` (new isolated tenant). The email must also
  be allowed by the Access policy, which is managed in Cloudflare.

## Storage

The Durable Object is required by the MCP transport; persistent data lives in
D1 so it is shared across sessions and clients.

Timestamps are stored as ISO 8601 UTC strings (e.g. `2026-05-14T07:30:00Z`).
"Days" (for daily rollups such as `check_indications` and
`get_stats window='today'`) are **Europe/Madrid** calendar days — the household
timezone — consistent across the MCP tools, the web UI, and the Alexa skill.

## Code layout

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
