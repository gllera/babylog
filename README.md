# babylog

A baby tracker deployed to **Cloudflare Workers**, backed by a single **D1**
database, scoped **per household** so the same history is visible to every
caregiver. It records feedings, diapers, routines/medication, and
growth (weight & height), and evaluates daily **indications** — fixed targets
like "1 poop a day" or "max 4h between feedings", plus formula-driven ones
(e.g. ml of milk per kg per day) that auto-progress as the baby grows.

One Worker exposes the data three ways over the same database:

- **MCP** (`/mcp`) — a Model Context Protocol server, for Claude and other MCP
  clients. → [docs/mcp-tools.md](docs/mcp-tools.md)
- **Web app** (`/app`) — an installable PWA (English/Spanish) with a read-only
  Today dashboard, charts, and quick logging forms. → [docs/web-ui.md](docs/web-ui.md)
- **Alexa** (`/alexa`) — a bilingual voice skill, English (`en-US`/`en-GB`:
  "*took 120 milliliters*", "*how are we doing*") and Spanish (`es-ES`: "*tomó
  120 mililitros*", "*cómo vamos hoy*"). → [alexa-skill/](alexa-skill/README.md)

Authentication is **Cloudflare Access** (Managed OAuth) fronting the whole
host; the Worker verifies the Access JWT and scopes all data to the
authenticated email's household.

## Quick start

```bash
npm install
npm run dev      # local Worker; MCP at http://localhost:8787/mcp, app at /app
```

Full install, D1 setup, Cloudflare Access config, and deploy steps are in
[docs/setup.md](docs/setup.md).

## Documentation

| Doc | What's in it |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Auth, the household/baby multi-user model, code layout, storage |
| [docs/mcp-tools.md](docs/mcp-tools.md) | Full MCP tool reference, timestamp semantics, connecting a client |
| [docs/web-ui.md](docs/web-ui.md) | The `/app` browser UI, tab by tab |
| [docs/setup.md](docs/setup.md) | Install, D1, Access config, deploy, tests, operational notes |
| [alexa-skill/README.md](alexa-skill/README.md) | Alexa skill setup |

## Tests

```bash
npm test            # vitest unit tests
npm run typecheck   # tsc --noEmit
```

Both run in CI on pushes to `main` and on PRs. A push to `main` then deploys
automatically: D1 migrations → Worker → Alexa interaction models
([docs/setup.md](docs/setup.md)).
