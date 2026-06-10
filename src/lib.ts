// Pure helpers shared by the MCP tools, the JSON API, and the Alexa skill.
// Kept free of Cloudflare-specific imports so it can be unit-tested in plain
// Node (see test/lib.test.ts).

const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export type AgeParts = {
  days: number;
  weeks: number;
  remDays: number;
  years: number;
  months: number;
};

export function computeAgeParts(dob: string, at?: Date): AgeParts | null {
  const birth = new Date(`${dob}T00:00:00Z`);
  const ref = at ?? new Date();
  const days = Math.floor((ref.getTime() - birth.getTime()) / DAY_MS);
  if (days < 0) return null;
  let years = ref.getUTCFullYear() - birth.getUTCFullYear();
  let months = ref.getUTCMonth() - birth.getUTCMonth();
  if (ref.getUTCDate() < birth.getUTCDate()) months--;
  if (months < 0) {
    years--;
    months += 12;
  }
  return {
    days,
    weeks: Math.floor(days / 7),
    remDays: days % 7,
    years,
    months,
  };
}

export function computeAge(dob: string, at?: Date): string {
  const parts = computeAgeParts(dob, at);
  if (!parts) return "not yet born";
  const { days, weeks, remDays, years, months } = parts;
  if (days < 60) {
    if (weeks === 0) return `${days} day${days === 1 ? "" : "s"} old`;
    return `${days} days old (${weeks}w${remDays > 0 ? ` ${remDays}d` : ""})`;
  }
  if (years === 0) {
    return `${months} month${months === 1 ? "" : "s"} old (${days} days)`;
  }
  return `${years}y ${months}m old (${days} days)`;
}

// Normalize a timestamp to the canonical `toISOString()` form (millisecond
// precision, Z suffix). All ordering and window logic compares stored ts
// strings lexicographically, so every insert must store this exact format —
// client-supplied values like "…T07:30:00Z" would otherwise mix precisions.
export function normalizeTs(when?: string): string {
  return (when ? new Date(when) : new Date()).toISOString();
}

export function humanizeGap(deltaMs: number): string {
  if (deltaMs < 0) return "in the future";
  const totalMin = Math.round(deltaMs / 60000);
  if (totalMin < 1) return "<1 min";
  if (totalMin < 60) return `${totalMin} min`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h > 0 ? `${days}d ${h}h` : `${days}d`;
}

export function formatGap(
  currentTs: string,
  prevTs: string | null,
  suffix = ""
): {
  gapStr: string | null;
  gapMin: number | null;
  gapNote: string;
} {
  if (!prevTs) return { gapStr: null, gapMin: null, gapNote: "" };
  const ms = new Date(currentTs).getTime() - new Date(prevTs).getTime();
  const gapStr = humanizeGap(ms);
  const tail = suffix ? ` ${suffix}` : "";
  return {
    gapStr,
    gapMin: Math.round(ms / 60000),
    gapNote: `  (${gapStr} since previous${tail})`,
  };
}

// Max gap in whole minutes between consecutive ascending timestamps,
// including the trailing gap from the last timestamp up to `boundary`
// (typically `min(window end, now)`). Callers should include the last
// event *before* the window in `timestamps` so the gap across the window
// start is measured too. Returns 0 when there are no timestamps at all.
export function maxGapMinutes(timestamps: string[], boundary: string): number {
  if (timestamps.length === 0) return 0;
  let maxMs = 0;
  for (let i = 1; i < timestamps.length; i++) {
    const gap = Date.parse(timestamps[i]) - Date.parse(timestamps[i - 1]);
    if (gap > maxMs) maxMs = gap;
  }
  const tail =
    Date.parse(boundary) - Date.parse(timestamps[timestamps.length - 1]);
  if (tail > maxMs) maxMs = tail;
  return Math.round(maxMs / 60000);
}

// Bounds are canonicalized via normalizeTs: stored ts strings are compared
// lexicographically, so an offset form ("…+02:00") or second-precision form
// ("…00Z") passed through raw would compare wrong as a string. Callers must
// pass parseable timestamps (validate first — normalizeTs throws otherwise).
export function buildWindowClauses(since?: string, until?: string) {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (since) {
    clauses.push("ts >= ?");
    params.push(normalizeTs(since));
  }
  if (until) {
    clauses.push("ts < ?");
    params.push(normalizeTs(until));
  }
  return { clauses, params };
}

// ---- Europe/Madrid civil-time helpers ---------------------------------------
//
// The household runs on Madrid time, so "a day" for stats and indications is
// the Madrid calendar day, not UTC. The EU DST rule is hand-rolled (rather
// than Intl, which workerd does support) so these stay deterministic and
// unit-testable in plain Node: CEST = UTC+2 from the last Sunday of March
// (03:00 local) to the last Sunday of October (03:00 local); CET = UTC+1 the
// rest of the year.

export function madridOffsetHours(date: Date): number {
  const year = date.getUTCFullYear();
  const march = new Date(Date.UTC(year, 2, 31));
  march.setUTCDate(31 - march.getUTCDay());
  march.setUTCHours(1, 0, 0, 0);
  const october = new Date(Date.UTC(year, 9, 31));
  october.setUTCDate(31 - october.getUTCDay());
  october.setUTCHours(1, 0, 0, 0);
  return date >= march && date < october ? 2 : 1;
}

// The Madrid calendar date (YYYY-MM-DD) at a given instant.
export function madridDateOf(at: Date): string {
  const local = new Date(at.getTime() + madridOffsetHours(at) * HOUR_MS);
  return local.toISOString().slice(0, 10);
}

export function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The UTC instant of Madrid local midnight at the start of the given date.
// (DST switches at 03:00 local, so midnight is never ambiguous.)
export function madridMidnightUtc(isoDate: string): Date {
  const utcMidnight = new Date(`${isoDate}T00:00:00Z`);
  return new Date(
    utcMidnight.getTime() - madridOffsetHours(utcMidnight) * HOUR_MS
  );
}

// [start, end) UTC ISO window covering the `periodDays` Madrid calendar days
// that end with (and include) `isoDate`.
export function madridDayWindow(
  isoDate: string,
  periodDays = 1
): { start: string; end: string } {
  return {
    start: madridMidnightUtc(addDaysIso(isoDate, -(periodDays - 1))).toISOString(),
    end: madridMidnightUtc(addDaysIso(isoDate, 1)).toISOString(),
  };
}

// "HH:MM" in Madrid local time for a UTC ISO timestamp.
export function madridHHMM(iso: string): string {
  const d = new Date(iso);
  const local = new Date(d.getTime() + madridOffsetHours(d) * HOUR_MS);
  const hh = local.getUTCHours();
  const mm = local.getUTCMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

export async function insertAndLookupPrev<P>(
  db: D1Database,
  selectStmt: D1PreparedStatement,
  insertStmt: D1PreparedStatement
): Promise<{ id: number; prev: P | undefined }> {
  const [prevRes, insRes] = await db.batch([selectStmt, insertStmt]);
  return {
    prev: (prevRes.results as P[])[0],
    id: (insRes.results as Array<{ id: number }>)[0]?.id ?? 0,
  };
}
