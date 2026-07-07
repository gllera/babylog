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
