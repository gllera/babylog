# Alexa skill — `Bitácora de Gabita` / `baby log`

A custom Alexa skill that talks to the same Cloudflare Worker as the MCP
server and the web app. Voice commands write to the same D1 database, so
anything you say to Alexa shows up immediately in the web UI and in MCP
clients.

**Bilingual.** The skill supports **Spanish** (`es-ES`, invocation *"bitácora
de gabita"*) and **English** (`en-US` + `en-GB`, invocation *"baby log"*).
Each reply follows the request's `locale`, so you talk to it in the language
your Alexa device is set to and it answers in kind — the language logic lives
in `src/alexa-i18n.ts` (`langOf` / `VOICES`). Which model Alexa uses is
decided by the **device's language setting**: set the device to English (or a
bilingual mode) to reach the English side. Routines are stored under their
canonical English names regardless of the spoken language, so web, MCP and
both Alexa languages stay consistent.

The skill uses an **HTTPS endpoint** (your Worker's URL + `/alexa`) — no AWS
Lambda needed.

## Patrones de invocación

### 🚀 Lo más rápido: Alexa Routines (1 utterance por toma)

La fricción principal está en decir el nombre de la skill. Las **Rutinas
de Alexa** lo eliminan: configuras un disparador corto (`Alexa, ciento
veinte`) que internamente le manda a la skill la frase completa (`tomó
ciento veinte mililitros`). Setup una vez, ahorro permanente.

**Setup en la app de Alexa (móvil):**

1. **Más → Rutinas → ➕ Nueva rutina**
2. **Cuando digas:** tu trigger corto, por ejemplo `Alexa, ciento veinte`
3. **➕ Añadir acción → Personalizado**
4. La frase que va dentro del campo de acción es la que la rutina pasará a la
   skill como si la hubieras dicho tú. Cualquiera de estas funciona:
   - `dile a bitácora de gabita que tomó ciento veinte mililitros`
   - `pregúntale a bitácora de gabita por ciento veinte mililitros`
5. **Guardar**

Repite para tus cantidades habituales (60, 90, 120, 150, 180, 200 ml).
Setup de ~20 min y tienes 1-utterance feedings durante meses.

Tras la rutina la skill cierra sesión automáticamente, así que cada
disparo es independiente.

> ⚠️ **Notas prácticas:**
> - El trigger no puede ser un número solo (Alexa exige al menos una
>   palabra). `Alexa, ciento veinte` funciona; `Alexa, 120` no siempre.
>   Si te resulta más cómodo, usa prefijos cortos: `Alexa, toma ciento
>   veinte`, `Alexa, anota ciento veinte`.
> - Si la app no tiene "Personalizado" en tu región, busca **"Habilidad"**
>   o **"Skill"** y pega la misma frase.

### Saludo cuando abres la skill normal

> "Alexa, **abre bitácora de gabita**"

Saludo corto: *"Sí, ¿cuántos mililitros?"*. Como acepta `{amount}` solo,
basta con decir el número:

```
Tú: "Alexa, abre bitácora de gabita"
Skill: "Sí, ¿cuántos mililitros?"
Tú: "ciento setenta y cinco"
Skill: "Apuntado: 175 mililitros, dos horas y diez minutos desde la toma anterior."
```

Si querías un pañal/rutina/resumen, dilo igual ("hizo caca", "cómo
vamos") — el prompt es solo un hint, la sesión acepta cualquier intent.

### One-shot directo (menos fiable)

> "Alexa, dile a bitácora de gabita que tomó ciento veinte mililitros"

En español, el patrón `dile a [skill] que ...` compite con la
mensajería de Alexa. Si la skill name forma un modismo con `a` (por
ejemplo `a diario`, `a menudo`, `a veces`), Alexa puede interpretar
mal la invocación y acabar anunciando el mensaje. El `invocationName`
actual está elegido para no formar locución con `a` (`a bitácora` no
significa nada en español) y para no chocar con features nativas
(`agenda` → calendario, `lista`, `alarma`, etc.). Aun así, las
rutinas o `abre` son más fiables.

### Una operación por sesión

Cada registro o consulta exitoso **cierra la sesión inmediatamente** — no
hay "¿algo más?". Si quieres registrar varias cosas seguidas, repite la
invocación (o, mejor, configura una rutina por cantidad para que cada
toma sea 1 utterance corta — ver más arriba).

La sesión solo queda abierta cuando la skill **necesita más info** para
completar la operación en curso, p. ej. dijiste "le di" sin nombrar la
rutina y te pregunta "¿qué rutina?"; ahí esperará tu respuesta.

La skill registra y consulta; **no borra**. Las correcciones/borrados
se hacen desde la web o el agente MCP.

## Voice cheat-sheet

| Si dices…                                     | Pasa…                                                              |
| --------------------------------------------- | ------------------------------------------------------------------ |
| "120" / "ciento veinte" / "120 mililitros" / "tomó 120 mililitros" | `record_feeding(120)` (+ gap desde la anterior) |
| "hizo pis" / "hizo caca" / "las dos cosas"    | `record_diaper(...)`                                               |
| "le di vitamina D" / "ya hicimos el baño"     | `record_routine("Vitamin D" / "Bath" / …)` — se guarda el nombre canónico en inglés, igual que la web y el MCP |
| "cómo vamos" / "resumen de hoy"               | Resumen de tomas + pañales + rutinas + última toma                 |
| "cuándo fue la última toma"                   | Hora y volumen de la última toma + cuánto hace                     |

La skill **solo expone los intents de uso frecuente por voz**: tomas,
pañales, rutinas, resumen y última toma. Pesos, tallas, notas libres y
edad se gestionan por la web (`/app`) o el agente MCP — operaciones raras
o con precisión que casa mal con ASR.

Synonyms (pis ↔ pipí ↔ mojado, baño ↔ bañito ↔ ducha, etc.) live in the
interaction model under `types[].values[].name.synonyms`.

## English (`baby log`)

Same skill, English locale — invocation **`baby log`**. Everything above
about Routines and one-operation-per-session applies identically; only the
words change. Open it with *"Alexa, open baby log"* and it replies *"Yes, how
many milliliters?"* — then just say the number.

| If you say…                                          | It does…                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| "120" / "took 120 milliliters"                       | `record_feeding(120)` (+ gap since the previous one)           |
| "did a pee" / "did a poop" / "both"                  | `record_diaper(...)`                                           |
| "gave vitamin D" / "did bath time"                   | `record_routine("Vitamin D" / "Bath" / …)` — the canonical English name is stored, same as web and MCP |
| "how are we doing" / "daily summary"                 | Summary of feedings + diapers + routines + last feeding        |
| "when was the last feeding"                          | Time and volume of the last feeding + how long ago             |

Spoken output is identical for `en-US` and `en-GB` (text-to-speech pronounces
"milliliters"/"millilitres" the same); both locales share
[`interaction-model.en.json`](./interaction-model.en.json), whose sample
utterances accept either spelling. English synonyms (pee ↔ wee ↔ wet, bath ↔
shower ↔ bath time, etc.) live in that file under
`types[].values[].name.synonyms`.

For 1-utterance feedings, set up an **Alexa Routine** exactly as in the
Spanish section above, using an English action phrase such as *"tell baby log
that took one hundred twenty milliliters"*.

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
2. **Skill name**: `Bitácora de Gabita`. **Primary locale**: `Spanish (ES)`.
   Then under **Skill → Languages** add **English (US)** and **English (UK)**
   as additional locales (they share one skill).
3. **Experience**: *Other* → *Custom*. **Hosting**: *Provision your own*.
4. **Template**: *Start from Scratch*.

### 3. Import the interaction models

For **each** locale, pick it in the language selector at the top of the
Interaction Model page, then:

1. In the left rail go to **Interaction Model → JSON Editor**.
2. Replace the contents with the matching file from this folder:
   - `Spanish (ES)` → [`interaction-model.es-ES.json`](./interaction-model.es-ES.json)
   - `English (US)` **and** `English (UK)` → [`interaction-model.en.json`](./interaction-model.en.json) (same file for both)
3. **Save Model**, then **Build Model** (a couple of minutes).

> **Note:** this manual import is only needed when creating the skill.
> After that, every push to `main` deploys all three locales automatically
> (the `alexa-model` job in `.github/workflows/ci.yml`, via SMAPI using the
> `ASK_REFRESH_TOKEN` + `ASK_VENDOR_ID` repo secrets) — right after the
> Worker deploys, so handlers are always live before new intents.

### 4. Point the skill at your Worker

1. **Endpoint** → *HTTPS*.
2. **Default Region**: paste `https://<your-worker-url>/alexa`.
3. **SSL certificate type**: *My development endpoint is a sub-domain of a
   domain that has a wildcard certificate from a certificate authority*
   (the `*.workers.dev` cert qualifies).
4. **Save Endpoints**.

### 5. Lock the endpoint to your skill

Each Alexa request contains the skill's `applicationId`. Once the
`ALEXA_APPLICATION_ID` secret is set, the Worker rejects every request
that doesn't match it (if the secret is unset, the check is skipped —
signature verification still applies).

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
2. Type or say: *abre bitácora de gabita*.
3. Then: *tomó ciento veinte mililitros* → Alexa should answer something
   like "*120 mililitros, dos horas y diez minutos.*"
4. To test English, switch the Test tab's language selector to English, then
   say *open baby log* → *took one hundred twenty milliliters* → Alexa answers
   like "*120 milliliters, 2 hours and 10 minutes.*"
5. Check `/app` in your browser — the entry is already there.

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
