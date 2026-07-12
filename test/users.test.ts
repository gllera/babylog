import { describe, expect, it } from "vitest";
import { pickBaby, removeBaby, updateBaby } from "../src/users";
import type { BabyRow } from "../src/types";

function baby(over: Partial<BabyRow>): BabyRow {
  return {
    id: 1,
    household_id: 1,
    name: null,
    sex: null,
    date_of_birth: null,
    is_default: 0,
    ...over,
  };
}

describe("pickBaby", () => {
  const sofia = baby({ id: 1, name: "Sofía", is_default: 0 });
  const luca = baby({ id: 2, name: "Luca", is_default: 1 });

  it("throws when the household has no babies", () => {
    expect(() => pickBaby([])).toThrow(/no babies/i);
  });

  it("returns the default baby when no ref is given", () => {
    expect(pickBaby([sofia, luca])).toBe(luca);
  });

  it("falls back to the first baby when none is flagged default", () => {
    const a = baby({ id: 3, name: "A" });
    const b = baby({ id: 4, name: "B" });
    expect(pickBaby([a, b])).toBe(a);
  });

  it("treats a blank ref like no ref", () => {
    expect(pickBaby([sofia, luca], "  ")).toBe(luca);
  });

  it("matches by name, case-insensitively", () => {
    expect(pickBaby([sofia, luca], "sofía")).toBe(sofia);
    expect(pickBaby([sofia, luca], "LUCA")).toBe(luca);
  });

  it("matches by numeric id", () => {
    expect(pickBaby([sofia, luca], "1")).toBe(sofia);
  });

  it("prefers an id match over a name that looks numeric", () => {
    const numeric = baby({ id: 7, name: "2" });
    expect(pickBaby([numeric, luca], "2")).toBe(luca); // id 2 wins
  });

  it("throws on an unknown ref, listing known babies", () => {
    expect(() => pickBaby([sofia, luca], "Mia")).toThrow(/No baby matching 'Mia'/);
    expect(() => pickBaby([sofia, luca], "Mia")).toThrow(/Sofía/);
  });

  it("throws on an ambiguous name, listing candidate ids", () => {
    const twin = baby({ id: 5, name: "Sofía" });
    expect(() => pickBaby([sofia, twin], "sofía")).toThrow(/Multiple babies/);
    expect(() => pickBaby([sofia, twin], "sofía")).toThrow(/1, 5/);
  });
});

// updateBaby assembles its UPDATE from whichever fields are present —
// `undefined` skips a column, `null` clears it. A capturing stub stands in
// for D1: what matters is the SQL shape and the bind order.
describe("updateBaby", () => {
  function stubDb(changes: number) {
    const calls: { sql: string; binds: unknown[] }[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            calls.push({ sql, binds });
            return { run: async () => ({ meta: { changes } }) };
          },
        };
      },
    };
    return { db: db as unknown as D1Database, calls };
  }

  it("updates only the provided fields, in order, stamping updated_at", async () => {
    const { db, calls } = stubDb(1);
    const ok = await updateBaby(db, 7, 3, { name: "Mía", date_of_birth: "2026-03-01" });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe(
      "UPDATE babies SET name = ?, date_of_birth = ?, updated_at = datetime('now') WHERE id = ? AND household_id = ?"
    );
    expect(calls[0].binds).toEqual(["Mía", "2026-03-01", 3, 7]);
  });

  it("null clears an optional column", async () => {
    const { db, calls } = stubDb(1);
    await updateBaby(db, 7, 3, { sex: null });
    expect(calls[0].sql).toContain("sex = ?");
    expect(calls[0].binds).toEqual([null, 3, 7]);
  });

  it("returns false without touching the DB when no fields are given", async () => {
    const { db, calls } = stubDb(1);
    expect(await updateBaby(db, 7, 3, {})).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("returns false when no row matches (wrong id or household)", async () => {
    const { db } = stubDb(0);
    expect(await updateBaby(db, 7, 999, { name: "X" })).toBe(false);
  });
});

// removeBaby verifies household membership before anything, then batches
// the diary tables + the baby row, promoting the oldest sibling when the
// default goes. The stub records SQL + binds off the bound statements.
describe("removeBaby", () => {
  function stubDb(row: { is_default: number } | null, changes: number[] = []) {
    let batched: { sql: string; binds: unknown[] }[] | null = null;
    const db = {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            return { sql, binds, first: async () => row };
          },
        };
      },
      batch: async (stmts: { sql: string; binds: unknown[] }[]) => {
        batched = stmts;
        return stmts.map((_, i) => ({ meta: { changes: changes[i] ?? 0 } }));
      },
    };
    return { db: db as unknown as D1Database, get batched() { return batched; } };
  }

  it("returns not-ok without deleting anything when the baby isn't in the household", async () => {
    const stub = stubDb(null);
    expect(await removeBaby(stub.db, 7, 99)).toEqual({ ok: false });
    expect(stub.batched).toBeNull();
  });

  it("deletes the six diary tables + the baby row, summing diary changes", async () => {
    const stub = stubDb({ is_default: 0 }, [5, 3, 2, 1, 1, 0, 1]);
    const res = await removeBaby(stub.db, 7, 3);
    expect(res).toEqual({ ok: true, records: 12 });
    const stmts = stub.batched!;
    expect(stmts).toHaveLength(7); // no default to reassign
    expect(stmts.some((s) => s.sql.includes("FROM notes"))).toBe(false); // dropped in 0003
    expect(stmts[0].sql).toBe("DELETE FROM feedings WHERE baby_id = ?");
    expect(stmts[6].sql).toBe("DELETE FROM babies WHERE id = ?");
    expect(stmts.every((s) => s.binds[0] === 3)).toBe(true);
  });

  it("promotes the oldest remaining baby when the default is removed", async () => {
    const stub = stubDb({ is_default: 1 });
    await removeBaby(stub.db, 7, 3);
    const stmts = stub.batched!;
    expect(stmts).toHaveLength(8);
    expect(stmts[7].sql).toContain("SET is_default = 1");
    expect(stmts[7].sql).toContain("ORDER BY id LIMIT 1");
    expect(stmts[7].binds).toEqual([7]);
  });
});
