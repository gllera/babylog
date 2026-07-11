// -----------------------------------------------------------------------------
// Alexa Custom Skill endpoint (bilingual: Spanish + English).
//
// Exposes /alexa on the same Worker so an Alexa skill can record feedings,
// diapers and routines, and ask "how is the day going" — all by voice. The
// language of each reply follows the request's `locale` (see `langOf` /
// `VOICES` in `alexa-i18n.ts`). The interaction models live in
// `alexa-skill/interaction-model.es-ES.json` (es-ES) and
// `alexa-skill/interaction-model.en.json` (en-US + en-GB).
//
// Auth: every Alexa request includes the skill's `applicationId`. We compare
// it against `ALEXA_APPLICATION_ID` (a wrangler secret). If `Signature` and
// `SignatureCertChainUrl` headers are present, we also verify them via
// node:crypto's X509Certificate / createVerify. Verification can be bypassed
// in local development by setting `ALEXA_SKIP_SIGNATURE=true`.
// -----------------------------------------------------------------------------

import { X509Certificate, createVerify } from "node:crypto";
import {
  MAX_FEEDING_ML,
  insertAndLookupPrev,
  madridDateOf,
  madridMidnightUtc,
  madridHHMM,
} from "./lib";
import type { DiaperKind } from "./types";
import { getBabies, pickBaby } from "./users";
import { langOf, VOICES, type Lang } from "./alexa-i18n";

export type AlexaEnv = {
  DB: D1Database;
  ALEXA_APPLICATION_ID?: string;
  ALEXA_SKIP_SIGNATURE?: string;
  ALEXA_HOUSEHOLD_ID?: string;
};

const MAX_TIMESTAMP_SKEW_MS = 150_000;
const CERT_CACHE_TTL_S = 86_400;

// Alexa has no Cloudflare Access identity (its Access app uses a service
// token via the Lambda bridge): events are attributed to 'alexa' and pinned
// to ALEXA_HOUSEHOLD_ID's default baby.
const ALEXA_USER = "alexa";

async function alexaBabyId(env: AlexaEnv): Promise<number> {
  const householdId = parseInt(env.ALEXA_HOUSEHOLD_ID ?? "1", 10) || 1;
  return pickBaby(await getBabies(env.DB, householdId)).id;
}

// ---- Alexa request / response types ----------------------------------------

interface AlexaSlotValue {
  name: string;
  id?: string;
}

interface AlexaSlot {
  name: string;
  value?: string;
  confirmationStatus?: string;
  resolutions?: {
    resolutionsPerAuthority: Array<{
      authority: string;
      status: { code: string };
      values?: Array<{ value: AlexaSlotValue }>;
    }>;
  };
}

interface AlexaIntent {
  name: string;
  confirmationStatus?: string;
  slots?: Record<string, AlexaSlot>;
}

interface AlexaRequestBody {
  type: "LaunchRequest" | "IntentRequest" | "SessionEndedRequest";
  requestId: string;
  timestamp: string;
  locale: string;
  intent?: AlexaIntent;
  reason?: string;
  error?: { type: string; message: string };
  dialogState?: string;
}

interface AlexaApplication {
  applicationId: string;
}

interface AlexaUser {
  userId: string;
  accessToken?: string;
}

interface AlexaSession {
  new: boolean;
  sessionId: string;
  application: AlexaApplication;
  user: AlexaUser;
  attributes?: Record<string, unknown>;
}

interface AlexaContext {
  System: {
    application: AlexaApplication;
    user: AlexaUser;
  };
}

interface AlexaRequestEnvelope {
  version: string;
  session?: AlexaSession;
  context?: AlexaContext;
  request: AlexaRequestBody;
}

interface AlexaOutputSpeech {
  type: "PlainText" | "SSML";
  text?: string;
  ssml?: string;
}

interface AlexaResponseEnvelope {
  version: "1.0";
  sessionAttributes?: Record<string, unknown>;
  response: {
    outputSpeech?: AlexaOutputSpeech;
    card?: {
      type: "Simple";
      title: string;
      content: string;
    };
    reprompt?: { outputSpeech: AlexaOutputSpeech };
    shouldEndSession: boolean;
  };
}

// ---- Tiny helpers ----------------------------------------------------------

interface SpeakOptions {
  endSession?: boolean;
  reprompt?: string;
  cardTitle?: string;
}

function speak(text: string, opts: SpeakOptions = {}): AlexaResponseEnvelope {
  const { endSession = true, reprompt, cardTitle } = opts;
  const out: AlexaResponseEnvelope = {
    version: "1.0",
    response: {
      outputSpeech: { type: "PlainText", text },
      shouldEndSession: endSession,
    },
  };
  if (reprompt) {
    out.response.reprompt = {
      outputSpeech: { type: "PlainText", text: reprompt },
    };
  }
  if (cardTitle) {
    out.response.card = { type: "Simple", title: cardTitle, content: text };
  }
  return out;
}

function jsonResponse(body: AlexaResponseEnvelope): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function slotResolution(
  slot: AlexaSlot | undefined
): AlexaSlotValue | undefined {
  const authorities = slot?.resolutions?.resolutionsPerAuthority ?? [];
  for (const a of authorities) {
    if (a.status.code === "ER_SUCCESS_MATCH" && a.values && a.values.length > 0) {
      return a.values[0].value;
    }
  }
  return undefined;
}

function slotResolvedId(slot: AlexaSlot | undefined): string | undefined {
  return slotResolution(slot)?.id;
}

function slotResolvedName(slot: AlexaSlot | undefined): string | undefined {
  return slotResolution(slot)?.name;
}

function slotRaw(slot: AlexaSlot | undefined): string | undefined {
  const v = slot?.value;
  return v && v.length > 0 ? v : undefined;
}

function slotNumber(slot: AlexaSlot | undefined): number | undefined {
  const raw = slotRaw(slot);
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

// ---- Routine name mapping (input side) -------------------------------------

// Canonical routine names match the web UI's English labels. When Alexa's
// synonym resolution fails (status != ER_SUCCESS_MATCH) the handler falls
// back to the raw user utterance, which is Spanish — this lookup pulls it
// back to the canonical so the DB stays consistent across web, MCP, Alexa.
const ROUTINE_CANONICAL: Record<string, string> = {
  "vitamin d": "Vitamin D",
  "vit d": "Vitamin D",
  "vitamina d": "Vitamin D",
  "vitamina de": "Vitamin D",
  vitamina: "Vitamin D",
  "gotas de vitamina": "Vitamin D",
  "gotas de vitamina d": "Vitamin D",
  // Alexa often segments "le di vitamina D" as carrier "le di vitamina" + a
  // bare "d"/"de" slot, which resolves to no synonym — map it back here.
  d: "Vitamin D",
  de: "Vitamin D",
  bath: "Bath",
  "baño": "Bath",
  bano: "Bath",
  "bañito": "Bath",
  "el baño": "Bath",
  "la bañera": "Bath",
  "la ducha": "Bath",
  ducha: "Bath",
  tummy: "Tummy",
  "tummy time": "Tummy",
  "panza abajo": "Tummy",
  "boca abajo": "Tummy",
  "rato boca abajo": "Tummy",
  walk: "Walk",
  paseo: "Walk",
  "paseíto": "Walk",
  paseito: "Walk",
  "paseo afuera": "Walk",
  salida: "Walk",
  paracetamol: "Paracetamol",
  apiretal: "Paracetamol",
  ibuprofen: "Ibuprofen",
  ibuprofeno: "Ibuprofen",
  ibu: "Ibuprofen",
  dalsy: "Ibuprofen",
  cream: "Cream",
  pomada: "Cream",
  crema: "Cream",
  "crema del culete": "Cream",
  syrup: "Syrup",
  jarabe: "Syrup",
  massage: "Massage",
  masaje: "Massage",
  masajito: "Massage",
  "el masaje": "Massage",
  // English fallback forms (the synonyms above are also in the en model).
  vitamin: "Vitamin D",
  "the vitamin": "Vitamin D",
  "vitamin drops": "Vitamin D",
  "vitamin dee": "Vitamin D",
  "a bath": "Bath",
  "bath time": "Bath",
  "the bath": "Bath",
  shower: "Bath",
  bathtub: "Bath",
  "bath tub": "Bath",
  "belly time": "Tummy",
  "on her tummy": "Tummy",
  "on his tummy": "Tummy",
  "on the tummy": "Tummy",
  "a walk": "Walk",
  walkies: "Walk",
  "went for a walk": "Walk",
  outside: "Walk",
  stroll: "Walk",
  tylenol: "Paracetamol",
  acetaminophen: "Paracetamol",
  advil: "Ibuprofen",
  motrin: "Ibuprofen",
  ibuprofin: "Ibuprofen",
  "the cream": "Cream",
  "diaper cream": "Cream",
  "nappy cream": "Cream",
  ointment: "Cream",
  "a massage": "Massage",
  "the massage": "Massage",
};

function canonicalRoutineName(raw: string): string {
  return ROUTINE_CANONICAL[raw.toLowerCase().trim()] ?? raw;
}

// ---- Request verification --------------------------------------------------

const SIG_HEADER_KEYS = ["signature", "Signature"] as const;
const CERT_HEADER_KEYS = [
  "signaturecertchainurl",
  "SignatureCertChainUrl",
] as const;

// Cache parsed X509 by source URL. Survives within an isolate so warm requests
// skip the PEM fetch and ASN.1 parse. Amazon rotates these only every few days.
const certCache = new Map<string, X509Certificate>();

function headerCaseInsensitive(
  request: Request,
  candidates: readonly string[]
): string | null {
  for (const k of candidates) {
    const v = request.headers.get(k);
    if (v) return v;
  }
  return null;
}

async function loadCert(certChainUrl: string): Promise<X509Certificate> {
  const cached = certCache.get(certChainUrl);
  if (cached) {
    const now = Date.now();
    if (
      now >= new Date(cached.validFrom).getTime() &&
      now <= new Date(cached.validTo).getTime()
    ) {
      return cached;
    }
    certCache.delete(certChainUrl);
  }
  const resp = await fetch(certChainUrl, {
    cf: { cacheTtl: CERT_CACHE_TTL_S, cacheEverything: true },
  });
  if (!resp.ok) {
    throw new Error(`cert fetch ${resp.status}`);
  }
  const pem = await resp.text();
  const cert = new X509Certificate(pem);
  certCache.set(certChainUrl, cert);
  return cert;
}

async function verifySignature(
  request: Request,
  body: string,
  env: AlexaEnv
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (env.ALEXA_SKIP_SIGNATURE === "true") return { ok: true };

  const certChainUrl = headerCaseInsensitive(request, CERT_HEADER_KEYS);
  const signature = headerCaseInsensitive(request, SIG_HEADER_KEYS);

  if (!certChainUrl || !signature) {
    return {
      ok: false,
      status: 400,
      message: "Missing Signature / SignatureCertChainUrl headers.",
    };
  }

  let url: URL;
  try {
    url = new URL(certChainUrl);
  } catch {
    return { ok: false, status: 400, message: "Invalid cert chain URL." };
  }
  if (url.protocol !== "https:")
    return { ok: false, status: 400, message: "Cert URL must be HTTPS." };
  if (url.hostname.toLowerCase() !== "s3.amazonaws.com")
    return {
      ok: false,
      status: 400,
      message: "Cert URL must be on s3.amazonaws.com.",
    };
  const normalized = url.pathname.replace(/\/+/g, "/");
  if (!normalized.startsWith("/echo.api/"))
    return {
      ok: false,
      status: 400,
      message: "Cert URL path must start with /echo.api/.",
    };
  if (url.port !== "" && url.port !== "443")
    return { ok: false, status: 400, message: "Cert URL must use port 443." };

  let cert: X509Certificate;
  try {
    cert = await loadCert(certChainUrl);
  } catch (e) {
    return {
      ok: false,
      status: 502,
      message: `Failed to load cert chain: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  try {
    const now = Date.now();
    const notBefore = new Date(cert.validFrom).getTime();
    const notAfter = new Date(cert.validTo).getTime();
    if (Number.isNaN(notBefore) || Number.isNaN(notAfter))
      return {
        ok: false,
        status: 400,
        message: "Cert has invalid validity dates.",
      };
    if (now < notBefore || now > notAfter)
      return { ok: false, status: 400, message: "Cert expired or not yet valid." };

    const san = cert.subjectAltName ?? "";
    if (!san.toLowerCase().includes("echo-api.amazon.com"))
      return {
        ok: false,
        status: 400,
        message: "Cert SAN missing echo-api.amazon.com.",
      };

    const verifier = createVerify("RSA-SHA1");
    verifier.update(body);
    verifier.end();
    const ok = verifier.verify(cert.publicKey, signature, "base64");
    if (!ok)
      return { ok: false, status: 400, message: "Signature did not verify." };
  } catch (e) {
    return {
      ok: false,
      status: 500,
      message: `Signature verification error: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  return { ok: true };
}

// ---- Main entry ------------------------------------------------------------

export async function handleAlexa(
  request: Request,
  env: AlexaEnv
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await request.text();

  const sig = await verifySignature(request, body, env);
  if (!sig.ok) {
    return new Response(sig.message, { status: sig.status });
  }

  let envelope: AlexaRequestEnvelope;
  try {
    envelope = JSON.parse(body) as AlexaRequestEnvelope;
  } catch {
    return new Response("Invalid JSON body.", { status: 400 });
  }

  const appId =
    envelope.session?.application.applicationId ??
    envelope.context?.System.application.applicationId;
  // Fail closed: the signature only proves the request came from *Amazon*, not
  // from *this* skill — the applicationId is what binds it to us. Skip the check
  // only in local dev, where signatures are already skipped. In production a
  // missing/mismatched app id is rejected, so another skill's signed request
  // can't be replayed into this household.
  if (env.ALEXA_SKIP_SIGNATURE !== "true" && appId !== env.ALEXA_APPLICATION_ID) {
    return new Response("Unknown applicationId.", { status: 401 });
  }

  // Valid JSON without a `request` (only reachable when signatures are skipped)
  // would otherwise throw a raw 500 below.
  if (!envelope.request || typeof envelope.request.type !== "string") {
    return new Response("Malformed Alexa request.", { status: 400 });
  }

  const ts = Date.parse(envelope.request.timestamp);
  if (
    !Number.isFinite(ts) ||
    Math.abs(Date.now() - ts) > MAX_TIMESTAMP_SKEW_MS
  ) {
    return new Response("Stale request timestamp.", { status: 400 });
  }

  const lang = langOf(envelope.request.locale);

  let reply: AlexaResponseEnvelope;
  try {
    reply = await route(envelope, env, lang);
  } catch (e) {
    // Log the detail server-side; never speak raw exception/SQL text back.
    console.error("alexa route error:", e);
    reply = speak(VOICES[lang].errorRecording());
  }
  return jsonResponse(reply);
}

async function route(
  envelope: AlexaRequestEnvelope,
  env: AlexaEnv,
  lang: Lang
): Promise<AlexaResponseEnvelope> {
  const r = envelope.request;
  if (r.type === "LaunchRequest") return handleLaunch(lang);
  if (r.type === "SessionEndedRequest") return speak("");
  if (r.type !== "IntentRequest" || !r.intent) {
    return speak(VOICES[lang].notUnderstood);
  }
  return dispatchIntent(r.intent, env, lang);
}

function handleLaunch(lang: Lang): AlexaResponseEnvelope {
  const v = VOICES[lang];
  return speak(v.launchPrompt, {
    endSession: false,
    reprompt: v.launchReprompt,
  });
}

async function dispatchIntent(
  intent: AlexaIntent,
  env: AlexaEnv,
  lang: Lang
): Promise<AlexaResponseEnvelope> {
  const v = VOICES[lang];
  switch (intent.name) {
    case "RecordFeedingIntent":
      return handleRecordFeeding(intent, env, lang);
    case "RecordDiaperIntent":
      return handleRecordDiaper(intent, env, lang);
    case "RecordRoutineIntent":
      return handleRecordRoutine(intent, env, lang);
    case "GetStatsIntent":
      return handleGetStats(env, lang);
    case "LastFeedingIntent":
      return handleLastFeeding(env, lang);
    case "AMAZON.HelpIntent":
      return speak(v.help, { endSession: false, reprompt: v.helpReprompt });
    case "AMAZON.CancelIntent":
    case "AMAZON.StopIntent":
    case "AMAZON.NavigateHomeIntent":
      return speak(v.goodbye);
    case "AMAZON.FallbackIntent":
      return speak(v.fallback, {
        endSession: false,
        reprompt: v.fallbackReprompt,
      });
    default:
      return speak(v.unknownCommand);
  }
}

// ---- Intent handlers -------------------------------------------------------

async function handleRecordFeeding(
  intent: AlexaIntent,
  env: AlexaEnv,
  lang: Lang
): Promise<AlexaResponseEnvelope> {
  const v = VOICES[lang];
  const amount = slotNumber(intent.slots?.amount);
  if (amount === undefined || amount <= 0 || amount > MAX_FEEDING_ML) {
    return speak(v.askMl, {
      endSession: false,
      reprompt: v.askMlReprompt,
    });
  }
  const amountMl = Math.round(amount);
  const babyId = await alexaBabyId(env);
  const now = Date.now();
  const ts = new Date(now).toISOString();
  const { prev } = await insertAndLookupPrev<{ ts: string }>(
    env.DB,
    env.DB.prepare(
      "SELECT ts FROM feedings WHERE baby_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1"
    ).bind(babyId, ts),
    env.DB.prepare(
      "INSERT INTO feedings (ts, amount_ml, baby_id, created_by) VALUES (?, ?, ?, ?) RETURNING id"
    ).bind(ts, amountMl, babyId, ALEXA_USER)
  );

  const tail = v.gapTail(prev, now, "feeding");
  return speak(v.feedingRecorded(amountMl, tail), {
    cardTitle: v.feedingCard,
  });
}

async function handleRecordDiaper(
  intent: AlexaIntent,
  env: AlexaEnv,
  lang: Lang
): Promise<AlexaResponseEnvelope> {
  const v = VOICES[lang];
  const id = slotResolvedId(intent.slots?.kind);
  let kind: DiaperKind | null = null;
  if (id === "pee" || id === "poop" || id === "both") {
    kind = id;
  } else {
    // Best-effort fallback (es + en) if synonym resolution gave no id. Combined
    // phrasings ("pis y caca" / "pee and poop") are checked first so they
    // aren't misread as just one kind.
    const raw = (
      slotResolvedName(intent.slots?.kind) ?? slotRaw(intent.slots?.kind) ?? ""
    ).toLowerCase();
    if (
      /(pis|pip[ií]|pee|wee).*(caca|pop[oó]|poop|poo)|(caca|pop[oó]|poop|poo).*(pis|pip[ií]|pee|wee)|ambos|las\s*dos|los\s*dos|todo|complet|both|everything|the works/.test(
        raw
      )
    )
      kind = "both";
    else if (
      /(^|\W)(pip[ií]?|pis|mojado|pee|wee|wet)(\W|$)/.test(raw) ||
      /number one/.test(raw)
    )
      kind = "pee";
    else if (
      /cac|pop[oó]|deposici|sucio|poop|poo|dirty/.test(raw) ||
      /number two/.test(raw)
    )
      kind = "poop";
  }
  if (!kind) {
    return speak(v.askDiaper, {
      endSession: false,
      reprompt: v.askDiaperReprompt,
    });
  }
  const babyId = await alexaBabyId(env);
  const now = Date.now();
  const ts = new Date(now).toISOString();
  const { prev } = await insertAndLookupPrev<{ ts: string }>(
    env.DB,
    env.DB.prepare(
      "SELECT ts FROM diapers WHERE baby_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1"
    ).bind(babyId, ts),
    env.DB.prepare(
      "INSERT INTO diapers (ts, kind, baby_id, created_by) VALUES (?, ?, ?, ?) RETURNING id"
    ).bind(ts, kind, babyId, ALEXA_USER)
  );

  const tail = v.gapTail(prev, now, "diaper");
  return speak(v.diaperRecorded(kind, tail), {
    cardTitle: v.diaperCard,
  });
}

async function handleRecordRoutine(
  intent: AlexaIntent,
  env: AlexaEnv,
  lang: Lang
): Promise<AlexaResponseEnvelope> {
  const v = VOICES[lang];
  // Alexa auto-generates an opaque `id` hash for every slot value when the
  // interaction model doesn't set one explicitly. The Routine slot type
  // defines no ids — only canonical name.value strings — so we read `name`
  // directly and ignore `id` here. If synonym resolution failed, slotRaw
  // returns the literal Spanish utterance; canonicalRoutineName maps it back
  // to the English canonical so the DB stays consistent with the web UI.
  const raw =
    slotResolvedName(intent.slots?.routine) ??
    slotRaw(intent.slots?.routine);
  if (!raw) {
    return speak(v.askRoutine, {
      endSession: false,
      reprompt: v.askRoutineReprompt,
    });
  }
  const name = canonicalRoutineName(raw);
  const babyId = await alexaBabyId(env);
  const now = Date.now();
  const ts = new Date(now).toISOString();
  const { prev } = await insertAndLookupPrev<{ ts: string }>(
    env.DB,
    env.DB.prepare(
      "SELECT ts FROM routines WHERE baby_id = ? AND ts < ? AND LOWER(name) = LOWER(?) ORDER BY ts DESC LIMIT 1"
    ).bind(babyId, ts, name),
    env.DB.prepare(
      "INSERT INTO routines (ts, name, baby_id, created_by) VALUES (?, ?, ?, ?) RETURNING id"
    ).bind(ts, name, babyId, ALEXA_USER)
  );

  const tail = v.gapTail(prev, now, "routine");
  return speak(v.routineRecorded(name, tail), {
    cardTitle: v.routineCard,
  });
}

async function handleGetStats(
  env: AlexaEnv,
  lang: Lang
): Promise<AlexaResponseEnvelope> {
  const v = VOICES[lang];
  // Window: "today" in Madrid local — same day boundary as check_indications.
  const now = new Date();
  const startIso = madridMidnightUtc(madridDateOf(now)).toISOString();
  const endIso = now.toISOString();
  const babyId = await alexaBabyId(env);

  const [feedAgg, diaperAgg, routineAgg] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_ml), 0) AS total, MAX(ts) AS last_ts
       FROM feedings WHERE baby_id = ? AND ts >= ? AND ts < ?`
    ).bind(babyId, startIso, endIso),
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN kind IN ('pee','both')  THEN 1 ELSE 0 END) AS pee_n,
         SUM(CASE WHEN kind IN ('poop','both') THEN 1 ELSE 0 END) AS poop_n
       FROM diapers WHERE baby_id = ? AND ts >= ? AND ts < ?`
    ).bind(babyId, startIso, endIso),
    env.DB.prepare(
      `SELECT name, COUNT(*) AS n FROM routines
       WHERE baby_id = ? AND ts >= ? AND ts < ?
       GROUP BY name ORDER BY n DESC`
    ).bind(babyId, startIso, endIso),
  ]);

  const feed = (feedAgg.results as Array<{
    n: number;
    total: number;
    last_ts: string | null;
  }>)[0] ?? { n: 0, total: 0, last_ts: null };
  const diaper = (diaperAgg.results as Array<{
    pee_n: number | null;
    poop_n: number | null;
  }>)[0] ?? { pee_n: 0, poop_n: 0 };
  const routines = routineAgg.results as Array<{ name: string; n: number }>;

  const parts: string[] = [];

  if (feed.n > 0) {
    parts.push(v.feedingSummary(feed.n, Math.round(feed.total)));
  }

  const pee = diaper.pee_n ?? 0;
  const poop = diaper.poop_n ?? 0;
  if (pee > 0 || poop > 0) {
    parts.push(v.diaperSummary(pee, poop));
  }

  if (routines.length > 0) {
    parts.push(v.routineSummary(routines.slice(0, 3)));
  }

  if (feed.last_ts) {
    parts.push(v.lastFeedingAt(madridHHMM(feed.last_ts)));
  }

  if (parts.length === 0) {
    return speak(v.statsEmpty, { cardTitle: v.statsCard });
  }
  return speak(`${v.statsIntro} ${parts.join(" ")}`, { cardTitle: v.statsCard });
}

async function handleLastFeeding(
  env: AlexaEnv,
  lang: Lang
): Promise<AlexaResponseEnvelope> {
  const v = VOICES[lang];
  const babyId = await alexaBabyId(env);
  const row = await env.DB.prepare(
    "SELECT ts, amount_ml FROM feedings WHERE baby_id = ? ORDER BY ts DESC LIMIT 1"
  )
    .bind(babyId)
    .first<{ ts: string; amount_ml: number }>();
  if (!row) {
    return speak(v.lastFeedingNone);
  }
  const ago = v.humanGap(Date.now() - Date.parse(row.ts));
  const amount = Math.round(row.amount_ml);
  return speak(v.lastFeeding(ago, madridHHMM(row.ts), amount), {
    cardTitle: v.lastFeedingCard,
  });
}

