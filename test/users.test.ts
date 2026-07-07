import { describe, expect, it } from "vitest";
import { pickBaby } from "../src/users";
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
