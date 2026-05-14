# baby-feeding-mcp

A remote **Model Context Protocol** (MCP) server, deployed to **Cloudflare
Workers**, that records baby feedings and diapers (pee / poop / both).
Everything is stored in a shared **D1** database so the same history is
visible to every MCP client that connects.

**Auth:** the `/mcp` endpoint is protected by OAuth 2.1. The server presents
a single-password consent page at `/authorize`; the password is stored as a
wrangler secret (`SHARED_SECRET`). Anyone with the password can authorize
an MCP client and get a normal OAuth bearer token. OAuth tokens are stored
in the `OAUTH_KV` namespace.

## Tools exposed

| Tool                | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `set_profile`       | Set baby's `name`, `sex`, `date_of_birth` (any combination)             |
| `get_profile`       | Read profile + computed age                                             |
| `record_feeding`    | Log a feeding: `amount_ml` (required), `when` (ISO ts), `note`          |
| `list_feedings`     | List feedings, newest first. Optional `since` / `until` / `limit`       |
| `delete_feeding`    | Remove a feeding by `id`                                                |
| `record_diaper`     | Log a diaper: `kind` ('pee' / 'poop' / 'both'), `when`, `note`          |
| `list_diapers`      | List diapers, newest first. Optional `since` / `until` / `kind` / `limit` |
| `delete_diaper`     | Remove a diaper event by `id`                                           |
| `record_medication` | Log a med/supplement: `name` (e.g. 'Vitamin D'), `dose`, `when`, `note` |
| `list_medications`  | List doses, newest first. Optional `since` / `until` / `name` / `limit` |
| `delete_medication` | Remove a dose by `id`                                                   |
| `record_observation`| Log a free-form observation (e.g. 'pimples on face'): `text`, `category`, `when` |
| `list_observations` | List observations. Optional `since` / `until` / `category` / `search` / `limit` |
| `delete_observation`| Remove an observation by `id`                                           |
| `record_weight`     | Log a weight in kg: `weight_kg`, `when`, `note` (reports delta vs prev) |
| `list_weights`      | List weight measurements. Optional `since` / `until` / `limit`          |
| `delete_weight`     | Remove a weight measurement by `id`                                     |
| `record_height`     | Log a length/height in cm: `height_cm`, `when`, `note` (reports delta)  |
| `list_heights`      | List height measurements. Optional `since` / `until` / `limit`          |
| `delete_height`     | Remove a height measurement by `id`                                     |
| `add_indication`    | Define a daily target (e.g. '1 poop a day'): `label`, `metric`, `target`, `comparison`, `filter` |
| `list_indications`  | List defined indications (active by default)                            |
| `delete_indication` | Remove an indication by `id`                                            |
| `check_indications` | Evaluate all active indications against a day's actuals (today by default) |
| `get_stats`         | Feedings + diapers + medications + observations summary + latest weight, over a window (default 24 h) |

All timestamps are ISO 8601 UTC strings (e.g. `2026-05-14T07:30:00Z`).

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
`REPLACE_WITH_DATABASE_ID_FROM_wrangler_d1_create`.

### 3. Apply the schema

```bash
# local (for `wrangler dev`)
npm run db:migrate:local

# production (after the database_id is set)
npm run db:migrate:remote
```

### 4. Run it

```bash
npm run dev
# MCP endpoint: http://localhost:8787/mcp
```

Open the MCP Inspector to poke at the tools:

```bash
npm run inspect
# Browser opens at http://localhost:5173 — point it at http://localhost:8787/mcp
```

### 5. Create the OAuth KV namespace + set the password

```bash
npx wrangler kv namespace create OAUTH_KV
# paste the returned id into wrangler.jsonc → kv_namespaces

# set the gate password (will prompt for input):
npx wrangler secret put SHARED_SECRET
```

### 6. Deploy

```bash
npm run deploy
# → https://baby-feeding-mcp.<your-subdomain>.workers.dev/mcp
```

## Connect from Claude Desktop

Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "baby-feeding": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://baby-feeding-mcp.<your-subdomain>.workers.dev/mcp"
      ]
    }
  }
}
```

Restart Claude Desktop. On the first connect a browser tab opens to
`/authorize` — enter the `SHARED_SECRET` password to approve. The token
is cached by `mcp-remote` afterward.

Then try:

> Record that the baby drank 120 ml at 7:30 this morning.
> Log a poopy diaper just now.
> She just peed and pooped, log it.
> How was the last 24 hours?

## Layout

```
.
├── src/index.ts                    # McpAgent + 7 tools (feedings, diapers, stats)
├── migrations/
│   ├── 0001_init.sql               # feedings table
│   └── 0002_diapers.sql            # diapers table
├── wrangler.jsonc                  # Worker + Durable Object + D1 bindings
├── tsconfig.json
└── package.json
```

## Notes

- A single shared password gates `/authorize`. To rotate it:
  `npx wrangler secret put SHARED_SECRET`. Existing bearer tokens stay
  valid; revoke a token by deleting its entry in the `OAUTH_KV` namespace.
- For per-user identities, swap the consent page for a GitHub/Google OAuth
  proxy (see `cloudflare/ai/demos/remote-mcp-github-oauth`).
- The Durable Object is required by the MCP transport; persistent feeding
  data lives in D1 so it is shared across sessions and clients.
