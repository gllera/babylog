import { describe, it, expect } from "vitest";
import {
  estimateWeightG,
  ageWeightVelocityGPerDay,
  ageDaysAt,
  GROWTH_FORMULAS,
  isGrowthFormula,
  resolveIndicationTarget,
  type WeightSample,
} from "../src/growth";

describe("ageWeightVelocityGPerDay", () => {
  it("tapers with age (0-3mo fastest)", () => {
    expect(ageWeightVelocityGPerDay(0)).toBeCloseTo(200 / 7);
    expect(ageWeightVelocityGPerDay(89)).toBeCloseTo(200 / 7);
    expect(ageWeightVelocityGPerDay(90)).toBeCloseTo(150 / 7);
    expect(ageWeightVelocityGPerDay(179)).toBeCloseTo(150 / 7);
    expect(ageWeightVelocityGPerDay(180)).toBeCloseTo(85 / 7);
    expect(ageWeightVelocityGPerDay(400)).toBeCloseTo(40 / 7);
  });
});

describe("estimateWeightG", () => {
  it("returns null with no weigh-ins", () => {
    expect(estimateWeightG([], new Date("2026-05-01T00:00:00Z"), "2026-04-01"))
      .toBeNull();
  });

  it("projects the baby's own trend forward (≥2 weigh-ins)", () => {
    // 3400g at birth, 4100g at 3wk → 700g / 21d = 33.33 g/day.
    const samples: WeightSample[] = [
      { ts: "2026-04-01T09:00:00Z", weight_g: 3400 },
      { ts: "2026-04-22T09:00:00Z", weight_g: 4100 },
    ];
    // 14 days after the latest weigh-in.
    const est = estimateWeightG(samples, new Date("2026-05-06T09:00:00Z"), "2026-04-01");
    expect(est).toBeCloseTo(4100 + (700 / 21) * 14, 1); // ≈4567
  });

  it("order of samples doesn't matter (sorted internally)", () => {
    const asc: WeightSample[] = [
      { ts: "2026-04-01T09:00:00Z", weight_g: 3400 },
      { ts: "2026-04-22T09:00:00Z", weight_g: 4100 },
    ];
    const at = new Date("2026-05-06T09:00:00Z");
    expect(estimateWeightG([...asc].reverse(), at, null)).toBe(
      estimateWeightG(asc, at, null)
    );
  });

  it("falls back to age-based velocity with a single weigh-in", () => {
    const samples: WeightSample[] = [
      { ts: "2026-04-22T09:00:00Z", weight_g: 4100 },
    ];
    // Latest weigh-in is at age 21d (0-3mo band → 200/7 g/day), +14 days.
    const est = estimateWeightG(samples, new Date("2026-05-06T09:00:00Z"), "2026-04-01");
    expect(est).toBeCloseTo(4100 + (200 / 7) * 14, 1);
  });

  it("never projects weight loss (rate floored at 0)", () => {
    // Newborn dip: 3400 → 3200 over the first week. Estimate must not drop.
    const samples: WeightSample[] = [
      { ts: "2026-04-01T09:00:00Z", weight_g: 3400 },
      { ts: "2026-04-08T09:00:00Z", weight_g: 3200 },
    ];
    const est = estimateWeightG(samples, new Date("2026-04-15T09:00:00Z"), "2026-04-01");
    expect(est).toBe(3200); // latest weight, no downward projection
  });

  it("caps the projection horizon at 60 days", () => {
    const samples: WeightSample[] = [
      { ts: "2026-04-01T09:00:00Z", weight_g: 3000 },
      { ts: "2026-04-11T09:00:00Z", weight_g: 3300 }, // 30 g/day
    ];
    // 200 days out, but only 60 days of gain should be applied.
    const est = estimateWeightG(samples, new Date("2026-10-28T09:00:00Z"), "2026-04-01");
    expect(est).toBeCloseTo(3300 + 30 * 60, 1);
  });

  it("clamps a noisy own-trend rate to 60 g/day", () => {
    // Two weigh-ins one day apart implying 500 g/day — clamp to 60.
    const samples: WeightSample[] = [
      { ts: "2026-04-01T09:00:00Z", weight_g: 3000 },
      { ts: "2026-04-02T09:00:00Z", weight_g: 3500 },
    ];
    const est = estimateWeightG(samples, new Date("2026-04-12T09:00:00Z"), "2026-04-01");
    expect(est).toBeCloseTo(3500 + 60 * 10, 1);
  });
});

describe("milk_ml_per_kg_day formula", () => {
  const milk = GROWTH_FORMULAS.milk_ml_per_kg_day;

  it("is 150 ml/kg/day rounded to 10", () => {
    expect(milk.compute({ estWeightG: 4560, ageDays: 35 })).toBe(680); // 684 → 680
    expect(milk.compute({ estWeightG: 3400, ageDays: 5 })).toBe(510); // 510
  });

  it("caps at 960 ml/day", () => {
    expect(milk.compute({ estWeightG: 8000, ageDays: 200 })).toBe(960);
  });

  it("is null without a weight estimate", () => {
    expect(milk.compute({ estWeightG: null, ageDays: 35 })).toBeNull();
  });
});

describe("age-driven formulas", () => {
  const feeds = GROWTH_FORMULAS.feeds_per_day;
  const gap = GROWTH_FORMULAS.feed_gap_max_by_age;
  const poops = GROWTH_FORMULAS.poops_per_day_by_age;

  it("feeds_per_day steps down with age", () => {
    expect(feeds.compute({ estWeightG: null, ageDays: 10 })).toBe(8);
    expect(feeds.compute({ estWeightG: null, ageDays: 28 })).toBe(7);
    expect(feeds.compute({ estWeightG: null, ageDays: 60 })).toBe(6);
    expect(feeds.compute({ estWeightG: null, ageDays: 120 })).toBe(5);
    expect(feeds.compute({ estWeightG: null, ageDays: 180 })).toBe(4);
  });

  it("feed_gap_max_by_age relaxes with age (minutes)", () => {
    expect(gap.compute({ estWeightG: null, ageDays: 10 })).toBe(240);
    expect(gap.compute({ estWeightG: null, ageDays: 28 })).toBe(300);
    expect(gap.compute({ estWeightG: null, ageDays: 90 })).toBe(360);
  });

  it("poops_per_day_by_age is 2 then 1 after 6 weeks", () => {
    expect(poops.compute({ estWeightG: null, ageDays: 41 })).toBe(2);
    expect(poops.compute({ estWeightG: null, ageDays: 42 })).toBe(1);
  });

  it("all age formulas are null without an age", () => {
    for (const f of [feeds, gap, poops]) {
      expect(f.compute({ estWeightG: 5000, ageDays: null })).toBeNull();
    }
  });
});

describe("resolveIndicationTarget", () => {
  it("returns the computed value for a growth formula", () => {
    const ind = { formula: "feeds_per_day", target: 6 };
    expect(resolveIndicationTarget(ind, { estWeightG: null, ageDays: 10 })).toBe(8);
  });

  it("falls back to the stored target when the formula can't compute", () => {
    const ind = { formula: "milk_ml_per_kg_day", target: 600 };
    // No weight estimate → fall back to stored 600.
    expect(resolveIndicationTarget(ind, { estWeightG: null, ageDays: 30 })).toBe(600);
  });

  it("returns the stored target for a plain (non-formula) indication", () => {
    const ind = { formula: null, target: 500 };
    expect(resolveIndicationTarget(ind, { estWeightG: 5000, ageDays: 30 })).toBe(500);
  });

  it("ignores an unknown formula key and uses the stored target", () => {
    const ind = { formula: "bogus", target: 42 };
    expect(resolveIndicationTarget(ind, { estWeightG: 5000, ageDays: 30 })).toBe(42);
  });
});

describe("helpers", () => {
  it("isGrowthFormula recognizes known keys only", () => {
    expect(isGrowthFormula("feeds_per_day")).toBe(true);
    expect(isGrowthFormula("bogus")).toBe(false);
    expect(isGrowthFormula(null)).toBe(false);
    expect(isGrowthFormula(undefined)).toBe(false);
  });

  it("ageDaysAt returns whole days or null", () => {
    expect(ageDaysAt("2026-04-01", new Date("2026-04-15T12:00:00Z"))).toBe(14);
    expect(ageDaysAt(null, new Date())).toBeNull();
    expect(ageDaysAt("2026-04-01", new Date("2026-03-01T00:00:00Z"))).toBeNull();
  });
});
