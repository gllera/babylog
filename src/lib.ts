// Pure helpers shared by the MCP tools, the JSON API, and the Alexa skill.
// Kept free of Cloudflare-specific imports so it can be unit-tested in plain
// Node.

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
  const days = Math.floor((ref.getTime() - birth.getTime()) / 86400000);
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
