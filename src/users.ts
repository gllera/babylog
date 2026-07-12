// Tenancy layer: resolve an authenticated email to its household + babies and
// pick which baby a request targets. `pickBaby` is pure (D1-free) so it can
// be unit-tested in plain Node (see test/users.test.ts), like lib.ts.

import type { BabyRow, UserRow } from "./types";

export type Tenant = {
  userId: number;
  email: string;
  householdId: number;
  babies: BabyRow[];
};

// Pick the baby a request targets. No `ref` → the household default (falling
// back to the oldest baby if none is flagged). `ref` matches a numeric id
// first, then a baby name (case-insensitive, exact). Throws with a
// caller-facing message when the pick is impossible.
export function pickBaby(babies: BabyRow[], ref?: string): BabyRow {
  if (babies.length === 0) {
    throw new Error("This household has no babies yet. Use add_baby first.");
  }
  const wanted = ref?.trim().toLowerCase() ?? "";
  if (wanted === "") {
    return babies.find((b) => b.is_default === 1) ?? babies[0];
  }
  if (/^\d+$/.test(wanted)) {
    const byId = babies.find((b) => b.id === parseInt(wanted, 10));
    if (byId) return byId;
  }
  const matches = babies.filter((b) => (b.name ?? "").toLowerCase() === wanted);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Multiple babies are named '${ref?.trim()}' — use the id instead (${matches
        .map((b) => b.id)
        .join(", ")}).`
    );
  }
  const known = babies
    .map((b) => `${b.name ?? "unnamed"} (#${b.id})`)
    .join(", ");
  throw new Error(`No baby matching '${ref?.trim()}'. Known babies: ${known}.`);
}

export function notRegisteredMessage(email: string): string {
  return `${email} is not registered in any household. Ask the household owner to run add_caregiver('${email}') from their MCP client.`;
}

export async function getBabies(
  db: D1Database,
  householdId: number
): Promise<BabyRow[]> {
  const { results } = await db
    .prepare(
      "SELECT id, household_id, name, sex, date_of_birth, is_default FROM babies WHERE household_id = ? ORDER BY id"
    )
    .bind(householdId)
    .all<BabyRow>();
  return results;
}

export type CaregiverRow = { id: number; email: string };

export async function listCaregivers(
  db: D1Database,
  householdId: number
): Promise<CaregiverRow[]> {
  const { results } = await db
    .prepare("SELECT id, email FROM users WHERE household_id = ? ORDER BY id")
    .bind(householdId)
    .all<CaregiverRow>();
  return results;
}

// Register `email` into the household so its owner sees and records the same
// data. Returns a caller-facing error string, or null on success. The email
// must also be allowed by the Cloudflare Access policy (that lives in
// Cloudflare, not here) or its owner still cannot reach the app.
export async function addCaregiver(
  db: D1Database,
  householdId: number,
  email: string
): Promise<string | null> {
  const norm = email.trim().toLowerCase();
  const existing = await db
    .prepare("SELECT id, email, household_id FROM users WHERE email = ?")
    .bind(norm)
    .first<UserRow>();
  if (existing) {
    return existing.household_id === householdId
      ? `${norm} is already a caregiver in your household.`
      : `${norm} already belongs to another household.`;
  }
  await db
    .prepare("INSERT INTO users (email, household_id) VALUES (?, ?)")
    .bind(norm, householdId)
    .run();
  return null;
}

export type RemoveCaregiverResult =
  | { ok: true }
  | { ok: false; code: "self" | "not_found"; message: string };

// Remove caregiver `targetId` from the caller's household. Self-removal is
// refused so a household always keeps at least one caregiver. Rows outside
// the household simply don't match — same "not found" as a bad id, no
// cross-tenant existence oracle.
export async function removeCaregiver(
  db: D1Database,
  tenant: { userId: number; householdId: number },
  targetId: number
): Promise<RemoveCaregiverResult> {
  if (targetId === tenant.userId) {
    return {
      ok: false,
      code: "self",
      message: "You can't remove yourself from your own household.",
    };
  }
  const res = await db
    .prepare("DELETE FROM users WHERE id = ? AND household_id = ?")
    .bind(targetId, tenant.householdId)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    return {
      ok: false,
      code: "not_found",
      message: `No caregiver #${targetId} in your household.`,
    };
  }
  return { ok: true };
}

// Insert a baby; the household's first baby becomes the default.
export async function addBaby(
  db: D1Database,
  householdId: number,
  existingBabies: number,
  fields: {
    name: string;
    sex?: "male" | "female";
    date_of_birth?: string;
  }
): Promise<{ id: number; is_default: boolean }> {
  const isDefault = existingBabies === 0 ? 1 : 0;
  const inserted = await db
    .prepare(
      "INSERT INTO babies (household_id, name, sex, date_of_birth, is_default) VALUES (?, ?, ?, ?, ?) RETURNING id"
    )
    .bind(
      householdId,
      fields.name,
      fields.sex ?? null,
      fields.date_of_birth ?? null,
      isDefault
    )
    .first<{ id: number }>();
  return { id: inserted?.id ?? 0, is_default: isDefault === 1 };
}

// Update a baby's identity facts. `undefined` leaves a column alone; `null`
// clears it (sex / date_of_birth only — a baby always keeps a name). Rows
// outside the household simply don't match — same "not found" as a bad id,
// no cross-tenant existence oracle.
export async function updateBaby(
  db: D1Database,
  householdId: number,
  babyId: number,
  fields: {
    name?: string;
    sex?: "male" | "female" | null;
    date_of_birth?: string | null;
  }
): Promise<boolean> {
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    binds.push(fields.name);
  }
  if (fields.sex !== undefined) {
    sets.push("sex = ?");
    binds.push(fields.sex);
  }
  if (fields.date_of_birth !== undefined) {
    sets.push("date_of_birth = ?");
    binds.push(fields.date_of_birth);
  }
  if (!sets.length) return false;
  sets.push("updated_at = datetime('now')");
  const res = await db
    .prepare(
      `UPDATE babies SET ${sets.join(", ")} WHERE id = ? AND household_id = ?`
    )
    .bind(...binds, babyId, householdId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// Tables that hold a baby's records. The schema has no foreign keys, so a
// baby's diary must be deleted alongside the baby or it lingers as
// invisible orphans.
const BABY_RECORD_TABLES = [
  "feedings",
  "diapers",
  "routines",
  "weights",
  "heights",
  "indications",
] as const;

// Permanently delete a baby and its entire diary. Membership is verified
// first so the record deletes can never touch another household's rows.
// If the default baby goes and siblings remain, the oldest inherits the
// flag (mirroring pickBaby's no-flag fallback, but stored). Returns the
// number of diary records that went with the baby.
export async function removeBaby(
  db: D1Database,
  householdId: number,
  babyId: number
): Promise<{ ok: true; records: number } | { ok: false }> {
  const row = await db
    .prepare("SELECT is_default FROM babies WHERE id = ? AND household_id = ?")
    .bind(babyId, householdId)
    .first<{ is_default: number }>();
  if (!row) return { ok: false };
  const stmts = BABY_RECORD_TABLES.map((t) =>
    db.prepare(`DELETE FROM ${t} WHERE baby_id = ?`).bind(babyId)
  );
  stmts.push(db.prepare("DELETE FROM babies WHERE id = ?").bind(babyId));
  if (row.is_default === 1) {
    stmts.push(
      db
        .prepare(
          "UPDATE babies SET is_default = 1 WHERE id = (SELECT id FROM babies WHERE household_id = ? ORDER BY id LIMIT 1)"
        )
        .bind(householdId)
    );
  }
  const results = await db.batch(stmts);
  let records = 0;
  for (let i = 0; i < BABY_RECORD_TABLES.length; i++) {
    records += results[i]?.meta?.changes ?? 0;
  }
  return { ok: true, records };
}

// null = authenticated but unregistered (callers turn this into a 403 with
// notRegisteredMessage). There is deliberately NO auto-provisioning: silent
// provisioning would split one family into two tenants the first time a
// second caregiver logs in.
export async function resolveTenant(
  db: D1Database,
  email: string
): Promise<Tenant | null> {
  const user = await db
    .prepare("SELECT id, email, household_id FROM users WHERE email = ?")
    .bind(email.toLowerCase())
    .first<UserRow>();
  if (!user) return null;
  return {
    userId: user.id,
    email: user.email,
    householdId: user.household_id,
    babies: await getBabies(db, user.household_id),
  };
}
