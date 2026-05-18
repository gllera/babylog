// -----------------------------------------------------------------------------
// Alexa Custom Skill endpoint (Spanish).
//
// Exposes /alexa on the same Worker so an Alexa skill can record feedings,
// diapers, routines, weights, heights and notes, and ask "how is the day
// going" — all by voice. The skill's interaction model lives in
// `alexa-skill/interaction-model.es-ES.json`.
//
// Auth: every Alexa request includes the skill's `applicationId`. We compare
// it against `ALEXA_APPLICATION_ID` (a wrangler secret). If `Signature` and
// `SignatureCertChainUrl` headers are present, we also verify them via
// node:crypto's X509Certificate / createVerify. Verification can be bypassed
// in local development by setting `ALEXA_SKIP_SIGNATURE=true`.
// -----------------------------------------------------------------------------

import { X509Certificate, createVerify } from "node:crypto";

export type AlexaEnv = {
  DB: D1Database;
  ALEXA_APPLICATION_ID?: string;
  ALEXA_SKIP_SIGNATURE?: string;
};

// ---- Alexa request / response types ----------------------------------------

interface AlexaSlot {
  name: string;
  value?: string;
  confirmationStatus?: string;
  resolutions?: {
    resolutionsPerAuthority: Array<{
      authority: string;
      status: { code: string };
      values?: Array<{ value: { name: string; id?: string } }>;
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

function speak(
  text: string,
  endSession = true,
  reprompt?: string,
  cardTitle?: string
): AlexaResponseEnvelope {
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

// Prefer the resolved slot id (set by the interaction-model synonym table)
// over the raw spoken value.
function slotResolvedId(slot: AlexaSlot | undefined): string | undefined {
  const authorities = slot?.resolutions?.resolutionsPerAuthority ?? [];
  for (const a of authorities) {
    if (a.status.code === "ER_SUCCESS_MATCH" && a.values && a.values.length > 0) {
      return a.values[0].value.id;
    }
  }
  return undefined;
}

function slotResolvedName(slot: AlexaSlot | undefined): string | undefined {
  const authorities = slot?.resolutions?.resolutionsPerAuthority ?? [];
  for (const a of authorities) {
    if (a.status.code === "ER_SUCCESS_MATCH" && a.values && a.values.length > 0) {
      return a.values[0].value.name;
    }
  }
  return undefined;
}

function slotRaw(slot: AlexaSlot | undefined): string | undefined {
  const v = slot?.value;
  return v && v.length > 0 ? v : undefined;
}

function slotNumber(slot: AlexaSlot | undefined): number | undefined {
  const raw = slotRaw(slot);
  if (raw === undefined) return undefined;
  // AMAZON.NUMBER returns digit strings like "120" or "4.25".
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
  march.setUTCHours(1, 0, 0, 0); // 03:00 local = 01:00 UTC
  const october = new Date(Date.UTC(year, 9, 31));
  october.setUTCDate(31 - october.getUTCDay());
  october.setUTCHours(1, 0, 0, 0);
  return date >= march && date < october ? 2 : 1;
}

function madridHHMM(iso: string): string {
  const d = new Date(iso);
  const local = new Date(d.getTime() + madridOffsetHours(d) * 3_600_000);
  const hh = local.getUTCHours();
  const mm = local.getUTCMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

// ---- Spanish formatters ----------------------------------------------------

function humanGapEs(deltaMs: number): string {
  if (deltaMs < 0) return "en el futuro";
  const totalMin = Math.round(deltaMs / 60_000);
  if (totalMin < 1) return "menos de un minuto";
  if (totalMin < 60) return totalMin === 1 ? "un minuto" : `${totalMin} minutos`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) {
    const hStr = hours === 1 ? "una hora" : `${hours} horas`;
    if (mins === 0) return hStr;
    const mStr = mins === 1 ? "un minuto" : `${mins} minutos`;
    return `${hStr} y ${mStr}`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  const dStr = days === 1 ? "un día" : `${days} días`;
  if (h === 0) return dStr;
  const hStr = h === 1 ? "una hora" : `${h} horas`;
  return `${dStr} y ${hStr}`;
}

function diaperKindEs(kind: "pee" | "poop" | "both"): string {
  if (kind === "pee") return "pis";
  if (kind === "poop") return "caca";
  return "pis y caca";
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
  // Normalize away "//", "/foo/../" etc. then re-check the prefix.
  const normalized = url.pathname.replace(/\/+/g, "/");
  if (!normalized.startsWith("/echo.api/"))
    return {
      ok: false,
      status: 400,
      message: "Cert URL path must start with /echo.api/.",
    };
  if (url.port !== "" && url.port !== "443")
    return { ok: false, status: 400, message: "Cert URL must use port 443." };

  let certPem: string;
  try {
    const resp = await fetch(certChainUrl);
    if (!resp.ok) {
      return {
        ok: false,
        status: 502,
        message: `Cert fetch returned ${resp.status}.`,
      };
    }
    certPem = await resp.text();
  } catch {
    return { ok: false, status: 502, message: "Failed to fetch cert chain." };
  }

  try {
    const cert = new X509Certificate(certPem);
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

  // applicationId check.
  const appId =
    envelope.session?.application.applicationId ??
    envelope.context?.System.application.applicationId;
  if (env.ALEXA_APPLICATION_ID && appId !== env.ALEXA_APPLICATION_ID) {
    return new Response("Unknown applicationId.", { status: 401 });
  }

  // Timestamp check: reject requests older than 150 s.
  const ts = Date.parse(envelope.request.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 150_000) {
    return new Response("Stale request timestamp.", { status: 400 });
  }

  let reply: AlexaResponseEnvelope;
  try {
    reply = await route(envelope, env);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reply = speak(
      `Lo siento, ha habido un error registrando eso: ${msg}`,
      true
    );
  }
  return jsonResponse(reply);
}

async function route(
  envelope: AlexaRequestEnvelope,
  env: AlexaEnv
): Promise<AlexaResponseEnvelope> {
  const r = envelope.request;
  if (r.type === "LaunchRequest") return handleLaunch();
  if (r.type === "SessionEndedRequest") return speak("", true);
  if (r.type !== "IntentRequest" || !r.intent) {
    return speak("Lo siento, no he entendido.", true);
  }
  return dispatchIntent(r.intent, env);
}

function handleLaunch(): AlexaResponseEnvelope {
  return speak(
    'Hola, soy el diario de Gabita. Puedes decir "tomó 120 mililitros", '
      + '"hizo caca", "le di vitamina D" o "cómo vamos hoy". ¿Qué quieres registrar?',
    false,
    'Puedes decir, por ejemplo, "120 mililitros" o "hizo pis".'
  );
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
    case "RecordWeightIntent":
      return handleRecordWeight(intent, env);
    case "RecordHeightIntent":
      return handleRecordHeight(intent, env);
    case "RecordNoteIntent":
      return handleRecordNote(intent, env);
    case "GetStatsIntent":
      return handleGetStats(env);
    case "LastFeedingIntent":
      return handleLastFeeding(env);
    case "GetProfileIntent":
      return handleGetProfile(env);
    case "AMAZON.HelpIntent":
      return speak(
        'Puedes registrar tomas diciendo "tomó 120 mililitros"; pañales '
          + 'con "hizo pis", "hizo caca" o "las dos cosas"; rutinas como "le di '
          + 'vitamina D" o "ya hicimos el baño"; peso con "pesa cuatro kilos '
          + 'doscientos cincuenta", o consultar el día con "cómo vamos". ¿Qué '
          + "quieres hacer?",
        false,
        "Dime qué quieres registrar."
      );
    case "AMAZON.CancelIntent":
    case "AMAZON.StopIntent":
      return speak("Hasta luego.", true);
    case "AMAZON.FallbackIntent":
      return speak(
        'No te he entendido. Puedes decir "tomó 120 mililitros" o "hizo caca". ¿Qué quieres registrar?',
        false,
        "¿Qué quieres registrar?"
      );
    default:
      return speak("No conozco esa orden todavía.", true);
  }
}

// ---- Intent handlers -------------------------------------------------------

async function handleRecordFeeding(
  intent: AlexaIntent,
  env: AlexaEnv
): Promise<AlexaResponseEnvelope> {
  const amount = slotNumber(intent.slots?.amount);
  if (amount === undefined || amount <= 0) {
    return speak(
      "¿Cuántos mililitros tomó?",
      false,
      'Dime los mililitros, por ejemplo "ciento veinte".'
    );
  }
  const amountMl = Math.round(amount);
  const ts = new Date().toISOString();
  const prev = await env.DB.prepare(
    "SELECT ts FROM feedings WHERE ts < ? ORDER BY ts DESC LIMIT 1"
  )
    .bind(ts)
    .first<{ ts: string }>();
  await env.DB.prepare("INSERT INTO feedings (ts, amount_ml) VALUES (?, ?)")
    .bind(ts, amountMl)
    .run();

  let tail = "";
  if (prev) {
    const gap = humanGapEs(new Date(ts).getTime() - new Date(prev.ts).getTime());
    tail = ` Han pasado ${gap} desde la anterior.`;
  }
  return speak(
    `Apuntada toma de ${amountMl} mililitros.${tail}`,
    true,
    undefined,
    "Toma registrada"
  );
}

async function handleRecordDiaper(
  intent: AlexaIntent,
  env: AlexaEnv
): Promise<AlexaResponseEnvelope> {
  // The interaction model maps each synonym to an id of "pee" / "poop" / "both".
  const id = slotResolvedId(intent.slots?.kind);
  let kind: "pee" | "poop" | "both" | null = null;
  if (id === "pee" || id === "poop" || id === "both") {
    kind = id;
  } else {
    // Best-effort fallback if the model wasn't built with ids.
    const raw = (slotResolvedName(intent.slots?.kind) ?? slotRaw(intent.slots?.kind) ?? "")
      .toLowerCase();
    if (/(^|\W)(pip[ií]?|pis|mojado)(\W|$)/.test(raw)) kind = "pee";
    else if (/cac|pop[oó]|deposici|sucio/.test(raw)) kind = "poop";
    else if (/(ambos|las\s*dos|los\s*dos|todo|complet|las\s*dos\s*cosas)/.test(raw))
      kind = "both";
  }
  if (!kind) {
    return speak(
      "¿Qué tipo de pañal? Puedes decir pis, caca o las dos cosas.",
      false,
      "Dime pis, caca o las dos cosas."
    );
  }
  const ts = new Date().toISOString();
  const prev = await env.DB.prepare(
    "SELECT ts FROM diapers WHERE ts < ? ORDER BY ts DESC LIMIT 1"
  )
    .bind(ts)
    .first<{ ts: string }>();
  await env.DB.prepare("INSERT INTO diapers (ts, kind) VALUES (?, ?)")
    .bind(ts, kind)
    .run();

  let tail = "";
  if (prev) {
    const gap = humanGapEs(new Date(ts).getTime() - new Date(prev.ts).getTime());
    tail = ` Han pasado ${gap} desde el anterior.`;
  }
  return speak(
    `Apuntado pañal de ${diaperKindEs(kind)}.${tail}`,
    true,
    undefined,
    "Pañal registrado"
  );
}

async function handleRecordRoutine(
  intent: AlexaIntent,
  env: AlexaEnv
): Promise<AlexaResponseEnvelope> {
  // Use the canonical id from the interaction model if present; otherwise
  // fall back to the spoken value (trim / collapse spaces).
  const id = slotResolvedId(intent.slots?.routine);
  const name =
    id ??
    slotResolvedName(intent.slots?.routine) ??
    slotRaw(intent.slots?.routine);
  if (!name) {
    return speak(
      "¿Qué rutina quieres registrar?",
      false,
      'Puedes decir, por ejemplo, "vitamina D", "baño" o "paseo".'
    );
  }
  const ts = new Date().toISOString();
  const prev = await env.DB.prepare(
    "SELECT ts FROM routines WHERE ts < ? AND LOWER(name) = LOWER(?) ORDER BY ts DESC LIMIT 1"
  )
    .bind(ts, name)
    .first<{ ts: string }>();
  await env.DB.prepare("INSERT INTO routines (ts, name) VALUES (?, ?)")
    .bind(ts, name)
    .run();

  let tail = "";
  if (prev) {
    const gap = humanGapEs(new Date(ts).getTime() - new Date(prev.ts).getTime());
    tail = ` Han pasado ${gap} desde la anterior.`;
  }
  return speak(
    `Apuntado: ${name}.${tail}`,
    true,
    undefined,
    "Rutina registrada"
  );
}

async function handleRecordWeight(
  intent: AlexaIntent,
  env: AlexaEnv
): Promise<AlexaResponseEnvelope> {
  const kilos = slotNumber(intent.slots?.kilos);
  const grams = slotNumber(intent.slots?.grams);
  let totalG: number | undefined;
  if (kilos !== undefined && grams !== undefined) {
    totalG = Math.round(kilos * 1000 + grams);
  } else if (kilos !== undefined) {
    // "Pesa 4 kilos" → 4000; "4.25 kilos" → 4250.
    totalG = Math.round(kilos * 1000);
  } else if (grams !== undefined) {
    // Rare path: "pesa 4250 gramos".
    totalG = Math.round(grams);
  }
  if (totalG === undefined || totalG <= 0) {
    return speak(
      "¿Cuánto pesa? Dime los kilos, por ejemplo, cuatro kilos doscientos cincuenta.",
      false
    );
  }
  const ts = new Date().toISOString();
  const prev = await env.DB.prepare(
    "SELECT weight_g FROM weights WHERE ts < ? ORDER BY ts DESC LIMIT 1"
  )
    .bind(ts)
    .first<{ weight_g: number }>();
  await env.DB.prepare("INSERT INTO weights (ts, weight_g) VALUES (?, ?)")
    .bind(ts, totalG)
    .run();

  let tail = "";
  if (prev) {
    const delta = totalG - prev.weight_g;
    if (delta === 0) tail = " Igual que la pesada anterior.";
    else {
      const sign = delta > 0 ? "más" : "menos";
      tail = ` ${Math.abs(delta)} gramos ${sign} que la pesada anterior.`;
    }
  }
  return speak(
    `Apuntado peso de ${totalG} gramos.${tail}`,
    true,
    undefined,
    "Peso registrado"
  );
}

async function handleRecordHeight(
  intent: AlexaIntent,
  env: AlexaEnv
): Promise<AlexaResponseEnvelope> {
  const cm = slotNumber(intent.slots?.cm);
  if (cm === undefined || cm <= 0) {
    return speak("¿Cuánto mide en centímetros?", false);
  }
  const cmInt = Math.round(cm);
  const ts = new Date().toISOString();
  const prev = await env.DB.prepare(
    "SELECT height_cm FROM heights WHERE ts < ? ORDER BY ts DESC LIMIT 1"
  )
    .bind(ts)
    .first<{ height_cm: number }>();
  await env.DB.prepare("INSERT INTO heights (ts, height_cm) VALUES (?, ?)")
    .bind(ts, cmInt)
    .run();

  let tail = "";
  if (prev) {
    const delta = cmInt - prev.height_cm;
    if (delta === 0) tail = " Igual que la medida anterior.";
    else {
      const sign = delta > 0 ? "más" : "menos";
      tail = ` ${Math.abs(delta)} centímetros ${sign} que la medida anterior.`;
    }
  }
  return speak(
    `Apuntada talla de ${cmInt} centímetros.${tail}`,
    true,
    undefined,
    "Talla registrada"
  );
}

async function handleRecordNote(
  intent: AlexaIntent,
  env: AlexaEnv
): Promise<AlexaResponseEnvelope> {
  const text = slotRaw(intent.slots?.text);
  if (!text) {
    return speak("¿Qué quieres anotar?", false);
  }
  const ts = new Date().toISOString();
  await env.DB.prepare("INSERT INTO notes (ts, text) VALUES (?, ?)")
    .bind(ts, text)
    .run();
  return speak(`Nota guardada: ${text}.`, true, undefined, "Nota guardada");
}

async function handleGetStats(env: AlexaEnv): Promise<AlexaResponseEnvelope> {
  // Window: "today" in Madrid local — convert local midnight back to UTC.
  const now = new Date();
  const offsetH = madridOffsetHours(now);
  const localNow = new Date(now.getTime() + offsetH * 3_600_000);
  const localMidnightUtcMs = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate()
  );
  const startIso = new Date(localMidnightUtcMs - offsetH * 3_600_000).toISOString();
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
  return speak(parts.join(" "), true, undefined, "Resumen de hoy");
}

async function handleLastFeeding(
  env: AlexaEnv
): Promise<AlexaResponseEnvelope> {
  const row = await env.DB.prepare(
    "SELECT ts, amount_ml FROM feedings ORDER BY ts DESC LIMIT 1"
  ).first<{ ts: string; amount_ml: number }>();
  if (!row) {
    return speak("No tengo ninguna toma registrada todavía.", true);
  }
  const ago = humanGapEs(Date.now() - new Date(row.ts).getTime());
  const amount = Math.round(row.amount_ml);
  return speak(
    `La última toma fue hace ${ago}, a las ${madridHHMM(row.ts)}, de ${amount} mililitros.`,
    true,
    undefined,
    "Última toma"
  );
}

async function handleGetProfile(
  env: AlexaEnv
): Promise<AlexaResponseEnvelope> {
  const row = await env.DB.prepare(
    "SELECT name, date_of_birth FROM profile WHERE id = 1"
  ).first<{ name: string | null; date_of_birth: string | null }>();
  if (!row?.date_of_birth) {
    return speak(
      "Todavía no he guardado la fecha de nacimiento.",
      true
    );
  }
  const birth = new Date(`${row.date_of_birth}T00:00:00Z`).getTime();
  const days = Math.floor((Date.now() - birth) / 86_400_000);
  const name = row.name ?? "Gabita";
  if (days < 0) {
    return speak(`${name} aún no ha nacido.`, true);
  }
  if (days < 60) {
    const weeks = Math.floor(days / 7);
    const rem = days % 7;
    let weeksStr = "";
    if (weeks > 0) {
      weeksStr =
        rem > 0
          ? ` (${weeks} ${weeks === 1 ? "semana" : "semanas"} y ${rem} ${
              rem === 1 ? "día" : "días"
            })`
          : ` (${weeks} ${weeks === 1 ? "semana" : "semanas"})`;
    }
    return speak(
      `${name} tiene ${days} ${days === 1 ? "día" : "días"}${weeksStr}.`,
      true,
      undefined,
      "Edad"
    );
  }
  const ref = new Date();
  const birthDate = new Date(`${row.date_of_birth}T00:00:00Z`);
  let years = ref.getUTCFullYear() - birthDate.getUTCFullYear();
  let months = ref.getUTCMonth() - birthDate.getUTCMonth();
  if (ref.getUTCDate() < birthDate.getUTCDate()) months--;
  if (months < 0) {
    years--;
    months += 12;
  }
  const partsAge: string[] = [];
  if (years > 0) partsAge.push(`${years} ${years === 1 ? "año" : "años"}`);
  if (months > 0)
    partsAge.push(`${months} ${months === 1 ? "mes" : "meses"}`);
  return speak(
    `${name} tiene ${partsAge.join(" y ")}.`,
    true,
    undefined,
    "Edad"
  );
}
