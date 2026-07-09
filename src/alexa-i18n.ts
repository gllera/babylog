// -----------------------------------------------------------------------------
// Alexa localization layer ("voices").
//
// The Alexa skill is bilingual: Spanish (`es-ES`) and English (`en-US`/`en-GB`).
// The request envelope carries `request.locale`; `langOf` collapses it to a
// `Lang`, and `VOICES[lang]` supplies every user-facing string and every
// language-specific formatter. The handlers in `alexa.ts` stay language-
// agnostic — they do the DB work and then ask the voice for words.
//
// Times are always Europe/Madrid, 24-hour (the household's timezone), formatted
// by the caller via `madridHHMM`; the voice only receives the ready "HH:MM"
// string. `en-US` and `en-GB` share one English voice (spoken output is TTS, so
// "milliliters"/"millilitres" sound identical).
// -----------------------------------------------------------------------------

import type { DiaperKind } from "./types";

export type Lang = "es" | "en";

/** What a record confirmation's gap refers to: the previous feeding, the
 *  previous diaper (any kind), or the previous run of the same routine. The
 *  spoken tail names it explicitly — a bare "2 hours and 10 minutes" left
 *  listeners guessing what the duration meant. */
export type GapEntity = "feeding" | "diaper" | "routine";

/** Collapse an Alexa locale ("en-US", "es-ES", …) to a supported language.
 *  Anything that isn't English falls back to Spanish (the original locale). */
export function langOf(locale: string | undefined): Lang {
  return (locale ?? "").toLowerCase().startsWith("en") ? "en" : "es";
}

export interface Voice {
  // ---- language-specific formatters ----
  humanGap(deltaMs: number): string;
  diaperKind(kind: DiaperKind): string;
  routineDisplay(canonical: string): string;
  gapTail(prev: { ts: string } | undefined, now: number, entity: GapEntity): string;

  // ---- launch / meta strings ----
  launchPrompt: string;
  launchReprompt: string;
  notUnderstood: string;
  help: string;
  helpReprompt: string;
  goodbye: string;
  fallback: string;
  fallbackReprompt: string;
  unknownCommand: string;
  errorRecording(msg: string): string;

  // ---- feeding ----
  askMl: string;
  askMlReprompt: string;
  feedingRecorded(amountMl: number, tail: string): string;
  feedingCard: string;

  // ---- diaper ----
  askDiaper: string;
  askDiaperReprompt: string;
  diaperRecorded(kind: DiaperKind, tail: string): string;
  diaperCard: string;

  // ---- routine ----
  askRoutine: string;
  askRoutineReprompt: string;
  routineRecorded(canonical: string, tail: string): string;
  routineCard: string;

  // ---- stats (each returns one sentence, period included) ----
  statsIntro: string;
  feedingSummary(n: number, totalMl: number): string;
  diaperSummary(pee: number, poop: number): string;
  routineSummary(routines: Array<{ name: string; n: number }>): string;
  lastFeedingAt(hhmm: string): string;
  statsEmpty: string;
  statsCard: string;

  // ---- last feeding ----
  lastFeedingNone: string;
  lastFeeding(ago: string, hhmm: string, amountMl: number): string;
  lastFeedingCard: string;
}

// =============================================================================
// Spanish
// =============================================================================

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

// Spanish display names for the voice response (the canonical name is the
// English form stored in the DB; this only affects what Alexa speaks back).
const ROUTINE_DISPLAY_ES: Record<string, string> = {
  "Vitamin D": "vitamina D",
  Bath: "baño",
  Tummy: "tummy",
  Walk: "paseo",
  Paracetamol: "paracetamol",
  Ibuprofen: "ibuprofeno",
  Cream: "pomada",
  Syrup: "jarabe",
  Massage: "masaje",
};

export const voiceEs: Voice = {
  humanGap: humanGapEs,
  diaperKind(kind) {
    if (kind === "pee") return "pis";
    if (kind === "poop") return "caca";
    return "pis y caca";
  },
  routineDisplay(canonical) {
    return ROUTINE_DISPLAY_ES[canonical] ?? canonical;
  },
  gapTail(prev, now, entity) {
    if (!prev) return "";
    const since =
      entity === "feeding"
        ? "desde la toma anterior"
        : entity === "diaper"
          ? "desde el pañal anterior"
          : "desde la última vez";
    return `, ${humanGapEs(now - Date.parse(prev.ts))} ${since}`;
  },

  launchPrompt: "Sí, ¿cuántos mililitros?",
  launchReprompt:
    'Dime los mililitros, o di "hizo caca", "le di vitamina D", "cómo vamos".',
  notUnderstood: "Lo siento, no he entendido.",
  help:
    'Di solo el número para registrar una toma, "hizo pis" o "hizo caca" '
    + 'para un pañal, "le di vitamina D" o "ya hicimos el baño" para una '
    + 'rutina, o "cómo vamos" para el resumen del día. ¿Qué quieres hacer?',
  helpReprompt: "Dime qué quieres registrar.",
  goodbye: "Hasta luego.",
  fallback:
    'No te he entendido. Puedes decir "tomó 120 mililitros" o "hizo caca". ¿Qué quieres registrar?',
  fallbackReprompt: "¿Qué quieres registrar?",
  unknownCommand: "No conozco esa orden todavía.",
  errorRecording(msg) {
    return `Lo siento, ha habido un error registrando eso: ${msg}`;
  },

  askMl: "¿Cuántos mililitros tomó?",
  askMlReprompt: 'Dime los mililitros, por ejemplo "ciento veinte".',
  feedingRecorded(amountMl, tail) {
    return `Apuntado: ${amountMl} mililitros${tail}.`;
  },
  feedingCard: "Toma registrada",

  askDiaper: "¿Qué tipo de pañal? Puedes decir pis, caca o las dos cosas.",
  askDiaperReprompt: "Dime pis, caca o las dos cosas.",
  diaperRecorded(kind, tail) {
    return `Apuntado: ${this.diaperKind(kind)}${tail}.`;
  },
  diaperCard: "Pañal registrado",

  askRoutine: "¿Qué rutina quieres registrar?",
  askRoutineReprompt: 'Puedes decir, por ejemplo, "vitamina D", "baño" o "paseo".',
  routineRecorded(canonical, tail) {
    return `Apuntado: ${this.routineDisplay(canonical)}${tail}.`;
  },
  routineCard: "Rutina registrada",

  statsIntro: "Hoy:",
  feedingSummary(n, totalMl) {
    return n === 1
      ? `1 toma, ${totalMl} mililitros.`
      : `${n} tomas, ${totalMl} mililitros en total.`;
  },
  diaperSummary(pee, poop) {
    const dp: string[] = [];
    if (pee > 0) dp.push(pee === 1 ? "1 pis" : `${pee} pises`);
    if (poop > 0) dp.push(poop === 1 ? "1 caca" : `${poop} cacas`);
    return `${dp.join(", ")}.`;
  },
  routineSummary(routines) {
    const r = routines
      .map((x) => {
        const d = this.routineDisplay(x.name);
        return x.n === 1 ? d : `${d} ${x.n} veces`;
      })
      .join(", ");
    return `${r}.`;
  },
  lastFeedingAt(hhmm) {
    return `Última toma a las ${hhmm}.`;
  },
  statsEmpty: "Sin registros hoy.",
  statsCard: "Resumen de hoy",

  lastFeedingNone: "No tengo ninguna toma registrada todavía.",
  lastFeeding(ago, hhmm, amountMl) {
    return `La última toma fue hace ${ago}, a las ${hhmm}, de ${amountMl} mililitros.`;
  },
  lastFeedingCard: "Última toma",
};

// =============================================================================
// English (en-US / en-GB)
// =============================================================================

function humanGapEn(deltaMs: number): string {
  if (deltaMs < 0) return "in the future";
  const totalMin = Math.round(deltaMs / 60_000);
  if (totalMin < 1) return "less than a minute";
  if (totalMin < 60) {
    return totalMin === 1 ? "a minute" : `${totalMin} minutes`;
  }
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) {
    const hStr = hours === 1 ? "an hour" : `${hours} hours`;
    if (mins === 0) return hStr;
    return `${hStr} and ${mins === 1 ? "a minute" : `${mins} minutes`}`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  const dStr = days === 1 ? "a day" : `${days} days`;
  if (h === 0) return dStr;
  return `${dStr} and ${h === 1 ? "an hour" : `${h} hours`}`;
}

// English display names (the DB canonical names are already English; this only
// tweaks casing/wording for speech, e.g. "Tummy" → "tummy time").
const ROUTINE_DISPLAY_EN: Record<string, string> = {
  "Vitamin D": "vitamin D",
  Bath: "bath",
  Tummy: "tummy time",
  Walk: "walk",
  Paracetamol: "paracetamol",
  Ibuprofen: "ibuprofen",
  Cream: "cream",
  Syrup: "syrup",
  Massage: "massage",
};

export const voiceEn: Voice = {
  humanGap: humanGapEn,
  diaperKind(kind) {
    if (kind === "pee") return "pee";
    if (kind === "poop") return "poop";
    return "pee and poop";
  },
  routineDisplay(canonical) {
    return ROUTINE_DISPLAY_EN[canonical] ?? canonical;
  },
  gapTail(prev, now, entity) {
    if (!prev) return "";
    const since =
      entity === "feeding"
        ? "since the previous feeding"
        : entity === "diaper"
          ? "since the previous diaper"
          : "since the last time";
    return `, ${humanGapEn(now - Date.parse(prev.ts))} ${since}`;
  },

  launchPrompt: "Yes, how many milliliters?",
  launchReprompt:
    'Tell me the milliliters, or say "did a poop", "gave vitamin D", "how are we doing".',
  notUnderstood: "Sorry, I didn't understand.",
  help:
    'Just say a number to log a feeding, "did a pee" or "did a poop" for a '
    + 'diaper, "gave vitamin D" or "did bath time" for a routine, or "how are '
    + 'we doing" for today\'s summary. What would you like to do?',
  helpReprompt: "Tell me what you'd like to log.",
  goodbye: "Goodbye.",
  fallback:
    'I didn\'t catch that. You can say "took 120 milliliters" or "did a poop". What would you like to log?',
  fallbackReprompt: "What would you like to log?",
  unknownCommand: "I don't know that command yet.",
  errorRecording(msg) {
    return `Sorry, there was an error logging that: ${msg}`;
  },

  askMl: "How many milliliters did the baby take?",
  askMlReprompt: 'Tell me the milliliters, for example "one hundred twenty".',
  feedingRecorded(amountMl, tail) {
    return `Logged: ${amountMl} milliliters${tail}.`;
  },
  feedingCard: "Feeding logged",

  askDiaper: "What kind of diaper? You can say pee, poop, or both.",
  askDiaperReprompt: "Tell me pee, poop, or both.",
  diaperRecorded(kind, tail) {
    return `Logged: ${this.diaperKind(kind)}${tail}.`;
  },
  diaperCard: "Diaper logged",

  askRoutine: "Which routine do you want to log?",
  askRoutineReprompt: 'You can say, for example, "vitamin D", "bath", or "walk".',
  routineRecorded(canonical, tail) {
    return `Logged: ${this.routineDisplay(canonical)}${tail}.`;
  },
  routineCard: "Routine logged",

  statsIntro: "Today:",
  feedingSummary(n, totalMl) {
    return n === 1
      ? `1 feeding, ${totalMl} milliliters.`
      : `${n} feedings, ${totalMl} milliliters in total.`;
  },
  diaperSummary(pee, poop) {
    const dp: string[] = [];
    if (pee > 0) dp.push(pee === 1 ? "1 pee" : `${pee} pees`);
    if (poop > 0) dp.push(poop === 1 ? "1 poop" : `${poop} poops`);
    return `${dp.join(", ")}.`;
  },
  routineSummary(routines) {
    const r = routines
      .map((x) => {
        const d = this.routineDisplay(x.name);
        return x.n === 1 ? d : `${d} ${x.n} times`;
      })
      .join(", ");
    return `${r}.`;
  },
  lastFeedingAt(hhmm) {
    return `Last feeding at ${hhmm}.`;
  },
  statsEmpty: "No entries today.",
  statsCard: "Today's summary",

  lastFeedingNone: "I don't have any feedings logged yet.",
  lastFeeding(ago, hhmm, amountMl) {
    return `The last feeding was ${ago} ago, at ${hhmm}, of ${amountMl} milliliters.`;
  },
  lastFeedingCard: "Last feeding",
};

export const VOICES: Record<Lang, Voice> = { es: voiceEs, en: voiceEn };
