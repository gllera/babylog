// -----------------------------------------------------------------------------
// Alexa Custom Skill endpoint (Spanish).
//
// Exposes /alexa on the same Worker so an Alexa skill can record feedings,
// diapers and routines, and ask "how is the day going" — all by voice. The
// skill's interaction model lives in `alexa-skill/interaction-model.es-ES.json`.
//
// Auth: every Alexa request includes the skill's `applicationId`. We compare
// it against `ALEXA_APPLICATION_ID` (a wrangler secret). If `Signature` and
// `SignatureCertChainUrl` headers are present, we also verify them via
// node:crypto's X509Certificate / createVerify. Verification can be bypassed
// in local development by setting `ALEXA_SKIP_SIGNATURE=true`.
// -----------------------------------------------------------------------------

import { X509Certificate, createVerify } from "node:crypto";
import { insertAndLookupPrev } from "./lib";

export type AlexaEnv = {
  DB: D1Database;
  ALEXA_APPLICATION_ID?: string;
  ALEXA_SKIP_SIGNATURE?: string;
};

type DiaperKind = "pee" | "poop" | "both";

const MS_PER_HOUR = 3_600_000;
const MAX_TIMESTAMP_SKEW_MS = 150_000;
const CERT_CACHE_TTL_S = 86_400;

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

// ---- Madrid timezone helpers (no Intl in workers without a polyfill) -------
//
// CEST = UTC+2 from the last Sunday of March (03:00 local) to the last
// Sunday of October (03:00 local). CET = UTC+1 the rest of the year.
function madridOffsetHours(date: Date): number {
  const year = date.getUTCFullYear();
  const march = new Date(Date.UTC(year, 2, 31));
  march.setUTCDate(31 - march.getUTCDay());
  march.setUTCHours(1, 0, 0, 0);
  const october = new Date(Date.UTC(year, 9, 31));
  october.setUTCDate(31 - october.getUTCDay());
  october.setUTCHours(1, 0, 0, 0);
  return date >= march && date < october ? 2 : 1;
}

function madridHHMM(iso: string): string {
  const d = new Date(iso);
  const local = new Date(d.getTime() + madridOffsetHours(d) * MS_PER_HOUR);
  const hh = local.getUTCHours();
  const mm = local.getUTCMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

// ---- Spanish formatters ----------------------------------------------------

function pluralEs(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

function humanGapEs(deltaMs: number): string {
  if (deltaMs < 0) return "en el futuro";
  const totalMin = Math.round(deltaMs / 60_000);
  if (totalMin < 1) return "menos de un minuto";
  if (totalMin < 60) {
    return totalMin === 1 ? "un minuto" : `${totalMin} minutos`;
  }
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) {
    const hStr = hours === 1 ? "una hora" : `${hours} horas`;
    if (mins === 0) return hStr;
    return `${hStr} y ${pluralEs(mins, "un minuto", `${mins} minutos`)}`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  const dStr = days === 1 ? "un día" : `${days} días`;
  if (h === 0) return dStr;
  return `${dStr} y ${pluralEs(h, "una hora", `${h} horas`)}`;
}

function diaperKindEs(kind: DiaperKind): string {
  if (kind === "pee") return "pis";
  if (kind === "poop") return "caca";
  return "pis y caca";
}

function gapTailEs(
  prev: { ts: string } | undefined,
  now: number
): string {
  if (!prev) return "";
  return `, ${humanGapEs(now - Date.parse(prev.ts))}`;
}

// Some words need agreement; "tomas" is feminine plural, "pañal" is masculine.
function feedingCountEs(n: number, totalMl: number): string {
  if (n === 0) return "ninguna toma";
  if (n === 1) return `una toma de ${totalMl} mililitros`;
  return `${n} tomas con un total de ${totalMl} mililitros`;
}

function diaperBreakdownEs(pee: number, poop: number): string {
  const parts: string[] = [];
  if (pee > 0) parts.push(pee === 1 ? "un pis" : `${pee} pises`);
  if (poop > 0) parts.push(poop === 1 ? "una caca" : `${poop} cacas`);
  if (parts.length === 0) return "ningún pañal";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} y ${parts[1]}`;
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
  if (env.ALEXA_APPLICATION_ID && appId !== env.ALEXA_APPLICATION_ID) {
    return new Response("Unknown applicationId.", { status: 401 });
  }

  const ts = Date.parse(envelope.request.timestamp);
  if (
    !Number.isFinite(ts) ||
    Math.abs(Date.now() - ts) > MAX_TIMESTAMP_SKEW_MS
  ) {
    return new Response("Stale request timestamp.", { status: 400 });
  }

  let reply: AlexaResponseEnvelope;
  try {
    reply = await route(envelope, env);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reply = speak(`Lo siento, ha habido un error registrando eso: ${msg}`);
  }
  return jsonResponse(reply);
}

async function route(
  envelope: AlexaRequestEnvelope,
  env: AlexaEnv
): Promise<AlexaResponseEnvelope> {
  const r = envelope.request;
  if (r.type === "LaunchRequest") return handleLaunch();
  if (r.type === "SessionEndedRequest") return speak("");
  if (r.type !== "IntentRequest" || !r.intent) {
    return speak("Lo siento, no he entendido.");
  }
  return dispatchIntent(r.intent, env);
}

function handleLaunch(): AlexaResponseEnvelope {
  return speak("Sí, ¿cuántos mililitros?", {
    endSession: false,
    reprompt:
      'Dime los mililitros, o di "hizo caca", "le di vitamina D", "cómo vamos".',
  });
}

async function dispatchIntent(
  intent: AlexaIntent,
  env: AlexaEnv
): Promise<AlexaResponseEnvelope> {
  switch (intent.name) {
    case "RecordFeedingIntent":
      return handleRecordFeeding(intent, env);
    case "RecordDiaperIntent":
      return handleRecordDiaper(intent, env);
    case "RecordRoutineIntent":
      return handleRecordRoutine(intent, env);
    case "GetStatsIntent":
      return handleGetStats(env);
    case "LastFeedingIntent":
      return handleLastFeeding(env);
    case "AMAZON.HelpIntent":
      return speak(
        'Di solo el número para registrar una toma, "hizo pis" o "hizo caca" '
          + 'para un pañal, "le di vitamina D" o "ya hicimos el baño" para una '
          + 'rutina, o "cómo vamos" para el resumen del día. ¿Qué quieres hacer?',
        { endSession: false, reprompt: "Dime qué quieres registrar." }
      );
    case "AMAZON.CancelIntent":
    case "AMAZON.StopIntent":
      return speak("Hasta luego.");
    case "AMAZON.FallbackIntent":
      return speak(
        'No te he entendido. Puedes decir "tomó 120 mililitros" o "hizo caca". ¿Qué quieres registrar?',
        { endSession: false, reprompt: "¿Qué quieres registrar?" }
      );
    default:
      return speak("No conozco esa orden todavía.");
  }
}

// ---- Intent handlers -------------------------------------------------------

async function handleRecordFeeding(
  intent: AlexaIntent,
  env: AlexaEnv
): Promise<AlexaResponseEnvelope> {
  const amount = slotNumber(intent.slots?.amount);
  if (amount === undefined || amount <= 0) {
    return speak("¿Cuántos mililitros tomó?", {
      endSession: false,
      reprompt: 'Dime los mililitros, por ejemplo "ciento veinte".',
    });
  }
  const amountMl = Math.round(amount);
  const now = Date.now();
  const ts = new Date(now).toISOString();
  const { prev } = await insertAndLookupPrev<{ ts: string }>(
    env.DB,
    env.DB.prepare(
      "SELECT ts FROM feedings WHERE ts < ? ORDER BY ts DESC LIMIT 1"
    ).bind(ts),
    env.DB.prepare(
      "INSERT INTO feedings (ts, amount_ml) VALUES (?, ?) RETURNING id"
    ).bind(ts, amountMl)
  );

  const tail = gapTailEs(prev, now);
  return speak(`${amountMl} mililitros${tail}.`, {
    cardTitle: "Toma registrada",
    endSession: false,
    reprompt: "¿Algo más?",
  });
}

async function handleRecordDiaper(
  intent: AlexaIntent,
  env: AlexaEnv
): Promise<AlexaResponseEnvelope> {
  const id = slotResolvedId(intent.slots?.kind);
  let kind: DiaperKind | null = null;
  if (id === "pee" || id === "poop" || id === "both") {
    kind = id;
  } else {
    // Best-effort fallback if the model wasn't built with ids.
    const raw = (
      slotResolvedName(intent.slots?.kind) ?? slotRaw(intent.slots?.kind) ?? ""
    ).toLowerCase();
    if (/(^|\W)(pip[ií]?|pis|mojado)(\W|$)/.test(raw)) kind = "pee";
    else if (/cac|pop[oó]|deposici|sucio/.test(raw)) kind = "poop";
    else if (/(ambos|las\s*dos|los\s*dos|todo|complet|las\s*dos\s*cosas)/.test(raw))
      kind = "both";
  }
  if (!kind) {
    return speak("¿Qué tipo de pañal? Puedes decir pis, caca o las dos cosas.", {
      endSession: false,
      reprompt: "Dime pis, caca o las dos cosas.",
    });
  }
  const now = Date.now();
  const ts = new Date(now).toISOString();
  const { prev } = await insertAndLookupPrev<{ ts: string }>(
    env.DB,
    env.DB.prepare(
      "SELECT ts FROM diapers WHERE ts < ? ORDER BY ts DESC LIMIT 1"
    ).bind(ts),
    env.DB.prepare(
      "INSERT INTO diapers (ts, kind) VALUES (?, ?) RETURNING id"
    ).bind(ts, kind)
  );

  const tail = gapTailEs(prev, now);
  return speak(`${diaperKindEs(kind)}${tail}.`, {
    cardTitle: "Pañal registrado",
    endSession: false,
    reprompt: "¿Algo más?",
  });
}

async function handleRecordRoutine(
  intent: AlexaIntent,
  env: AlexaEnv
): Promise<AlexaResponseEnvelope> {
  // Alexa auto-generates an opaque `id` hash for every slot value when the
  // interaction model doesn't set one explicitly. The Routine slot type
  // defines no ids — only canonical name.value strings — so we read `name`
  // directly and ignore `id` here.
  const name =
    slotResolvedName(intent.slots?.routine) ??
    slotRaw(intent.slots?.routine);
  if (!name) {
    return speak("¿Qué rutina quieres registrar?", {
      endSession: false,
      reprompt: 'Puedes decir, por ejemplo, "vitamina D", "baño" o "paseo".',
    });
  }
  const now = Date.now();
  const ts = new Date(now).toISOString();
  const { prev } = await insertAndLookupPrev<{ ts: string }>(
    env.DB,
    env.DB.prepare(
      "SELECT ts FROM routines WHERE ts < ? AND LOWER(name) = LOWER(?) ORDER BY ts DESC LIMIT 1"
    ).bind(ts, name),
    env.DB.prepare(
      "INSERT INTO routines (ts, name) VALUES (?, ?) RETURNING id"
    ).bind(ts, name)
  );

  const tail = gapTailEs(prev, now);
  return speak(`${name}${tail}.`, {
    cardTitle: "Rutina registrada",
    endSession: false,
    reprompt: "¿Algo más?",
  });
}

async function handleGetStats(env: AlexaEnv): Promise<AlexaResponseEnvelope> {
  // Window: "today" in Madrid local — convert local midnight back to UTC.
  const now = new Date();
  const offsetH = madridOffsetHours(now);
  const localNow = new Date(now.getTime() + offsetH * MS_PER_HOUR);
  const localMidnightUtcMs = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate()
  );
  const startIso = new Date(localMidnightUtcMs - offsetH * MS_PER_HOUR).toISOString();
  const endIso = now.toISOString();

  const [feedAgg, diaperAgg, routineAgg] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_ml), 0) AS total, MAX(ts) AS last_ts
       FROM feedings WHERE ts >= ? AND ts < ?`
    ).bind(startIso, endIso),
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN kind IN ('pee','both')  THEN 1 ELSE 0 END) AS pee_n,
         SUM(CASE WHEN kind IN ('poop','both') THEN 1 ELSE 0 END) AS poop_n
       FROM diapers WHERE ts >= ? AND ts < ?`
    ).bind(startIso, endIso),
    env.DB.prepare(
      `SELECT name, COUNT(*) AS n FROM routines
       WHERE ts >= ? AND ts < ?
       GROUP BY name ORDER BY n DESC`
    ).bind(startIso, endIso),
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
  parts.push(`Hoy llevamos ${feedingCountEs(feed.n, Math.round(feed.total))}.`);
  parts.push(
    `Pañales: ${diaperBreakdownEs(diaper.pee_n ?? 0, diaper.poop_n ?? 0)}.`
  );
  if (routines.length > 0) {
    const r = routines
      .slice(0, 3)
      .map((x) => (x.n === 1 ? x.name : `${x.name} (${x.n})`))
      .join(", ");
    parts.push(`Rutinas: ${r}.`);
  }
  if (feed.last_ts) {
    parts.push(`Última toma a las ${madridHHMM(feed.last_ts)}.`);
  }
  return speak(parts.join(" "), {
    cardTitle: "Resumen de hoy",
    endSession: false,
    reprompt: "¿Algo más?",
  });
}

async function handleLastFeeding(
  env: AlexaEnv
): Promise<AlexaResponseEnvelope> {
  const row = await env.DB.prepare(
    "SELECT ts, amount_ml FROM feedings ORDER BY ts DESC LIMIT 1"
  ).first<{ ts: string; amount_ml: number }>();
  if (!row) {
    return speak("No tengo ninguna toma registrada todavía.", {
      endSession: false,
      reprompt: "¿Algo más?",
    });
  }
  const ago = humanGapEs(Date.now() - Date.parse(row.ts));
  const amount = Math.round(row.amount_ml);
  return speak(
    `La última toma fue hace ${ago}, a las ${madridHHMM(row.ts)}, de ${amount} mililitros.`,
    { cardTitle: "Última toma", endSession: false, reprompt: "¿Algo más?" }
  );
}

