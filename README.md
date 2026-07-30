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

Authentication is dual during the llera.eu → 32b.io transition: `baby.32b.io`
uses the shared 32b.io magic-link session (self-service — new users create a
household or accept a caregiver invite at `/welcome`), while `baby.llera.eu`
stays behind Cloudflare Access (still fronting MCP and Alexa). The Worker
verifies whichever credential arrives and scopes all data to the email's
household. The baby.32b.io route is not yet declared; see docs/setup.md for
the go-live steps.

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
