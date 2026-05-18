# Alexa skill — `Diario de Gabita`

A custom Alexa skill (Spanish, `es-ES`) that talks to the same Cloudflare
Worker as the MCP server and the web app. Voice commands write to the same
D1 database, so anything you say to Alexa shows up immediately in the web UI
and in MCP clients.

The skill uses an **HTTPS endpoint** (your Worker's URL + `/alexa`) — no AWS
Lambda needed.

## Voice cheat-sheet

> "Alexa, abre **diario de gabita**"

| Si dices…                                     | Pasa…                                                              |
| --------------------------------------------- | ------------------------------------------------------------------ |
| "tomó 120 mililitros"                         | `record_feeding(120)` (+ gap desde la anterior)                    |
| "hizo pis" / "hizo caca" / "las dos cosas"    | `record_diaper(...)`                                               |
| "le di vitamina D" / "ya hicimos el baño"     | `record_routine("Vitamina D" / "Baño" / …)`                        |
| "pesa cuatro kilos doscientos cincuenta"      | `record_weight(4250)`                                              |
| "mide 53 centímetros"                         | `record_height(53)`                                                |
| "anota que tiene granitos en la cara"         | `record_note("tiene granitos en la cara")`                         |
| "cómo vamos" / "resumen de hoy"               | Resumen de tomas + pañales + rutinas + última toma                 |
| "cuándo fue la última toma"                   | Hora y volumen de la última toma + cuánto hace                     |
| "cuántos días tiene"                          | Edad de Gabita (días / semanas / meses)                            |

Synonyms (pis ↔ pipí ↔ mojado, baño ↔ bañito ↔ ducha, etc.) live in the
interaction model under `types[].values[].name.synonyms`.

## Setup

You'll need an Amazon developer account (free) and a deployed copy of this
Worker.

### 1. Deploy the Worker first

```bash
npm run deploy
```

Note the URL printed at the end — e.g.
`https://baby-feeding-mcp.<subdomain>.workers.dev`. The Alexa endpoint will
be that URL + `/alexa`.

### 2. Create the skill

1. Go to <https://developer.amazon.com/alexa/console/ask> and click
   **Create Skill**.
2. **Skill name**: `Diario de Gabita`. **Primary locale**: `Spanish (ES)`.
3. **Experience**: *Other* → *Custom*. **Hosting**: *Provision your own*.
4. **Template**: *Start from Scratch*.

### 3. Import the interaction model

1. In the left rail go to **Interaction Model → JSON Editor**.
2. Replace the contents with
   [`interaction-model.es-ES.json`](./interaction-model.es-ES.json) from
   this folder.
3. **Save Model**, then **Build Model** (a couple of minutes).

### 4. Point the skill at your Worker

1. **Endpoint** → *HTTPS*.
2. **Default Region**: paste `https://<your-worker-url>/alexa`.
3. **SSL certificate type**: *My development endpoint is a sub-domain of a
   domain that has a wildcard certificate from a certificate authority*
   (the `*.workers.dev` cert qualifies).
4. **Save Endpoints**.

### 5. Lock the endpoint to your skill

Each Alexa request contains the skill's `applicationId`. The Worker
rejects every request that doesn't match `ALEXA_APPLICATION_ID`.

1. Copy your skill ID from the Alexa console (top-left, under the skill
   name — `amzn1.ask.skill.…`).
2. Set it as a wrangler secret:

   ```bash
   npx wrangler secret put ALEXA_APPLICATION_ID
   # paste the amzn1.ask.skill.* value when prompted
   ```

That's the only mandatory secret. The Worker also verifies the request
signature (`Signature` / `SignatureCertChainUrl` headers) using the cert
served by `s3.amazonaws.com/echo.api/`, so requests forged from another
skill or from a random client are also rejected.

### 6. Try it

1. Alexa console → **Test** tab → switch to **Development** (top-left).
2. Type or say: *abre diario de gabita*.
3. Then: *tomó ciento veinte mililitros* → Alexa should answer something
   like "*Apuntada toma de 120 mililitros. Han pasado dos horas y diez
   minutos desde la anterior.*"
4. Check `/app` in your browser — the entry is already there.

When happy, link the skill to your real Echo by enabling it under the
**Your Skills → Dev** tab of the Alexa app.

## Local development

`wrangler dev` runs on `http://localhost:8787`, which Alexa **can't** reach
(it has to be public HTTPS). Two options:

- **Cloudflared tunnel**:

  ```bash
  npx wrangler dev          # one terminal
  cloudflared tunnel --url http://localhost:8787   # another terminal
  ```

  Paste the printed `https://<...>.trycloudflare.com/alexa` URL into the
  Alexa endpoint while developing.

- Or just push to your real Worker (`npm run deploy`) and test against it
  directly — that's usually easier.

For local testing without Amazon's signing headers (e.g. with `curl`), set
the bypass secret:

```bash
npx wrangler secret put ALEXA_SKIP_SIGNATURE
# value: true
```

**Remove it before connecting the skill to a real device** — otherwise
anyone who learns your endpoint URL can record entries.

## Troubleshooting

- **`Unknown applicationId`** — `ALEXA_APPLICATION_ID` doesn't match the
  skill ID. Re-copy from the console (skill ID, not skill name).
- **`Stale request timestamp`** — your Worker's clock is wildly off (very
  unlikely on Cloudflare), or you replayed an old request.
- **`Signature did not verify`** — the request body was modified in flight
  or the cert chain URL was tampered with. Make sure no middleware is
  rewriting the request body.
- **"There was a problem with the requested skill's response"** — open the
  Alexa console **Test** tab → **Skill I/O**; the raw JSON shows the
  Worker's error message in the speech text.
