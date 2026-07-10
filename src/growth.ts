// Growth-based indication targets: compute a "Today's targets" number from the
// baby's estimated weight and age, so targets progress as the baby grows
// instead of being fixed. Kept pure (no Cloudflare imports) so it can be
// unit-tested in plain Node — see test/growth.test.ts.

import { computeAgeParts, DAY_MS } from "./lib";

export type WeightSample = { ts: string; weight_g: number };

// Standard weight-gain velocity (grams/day) by age, from WHO/AAP growth norms:
// ~200 g/wk in the first 3 months, tapering with age. Used to project the
// current weight when the baby's own recent trend isn't available yet.
export function ageWeightVelocityGPerDay(ageDays: number): number {
  if (ageDays < 90) return 200 / 7; // 0–3 mo
  if (ageDays < 180) return 150 / 7; // 3–6 mo
  if (ageDays < 365) return 85 / 7; // 6–12 mo
  return 40 / 7; // 12 mo+
}

// Don't extrapolate a stale weigh-in forever, and clamp noisy own-trend rates
// (a cheap scale or a close-together pair can imply an absurd g/day).
const MAX_PROJECTION_DAYS = 60;
const MAX_TREND_G_PER_DAY = 60;

// Estimate the baby's weight (grams) at instant `at`. Hybrid:
//   • ≥2 weigh-ins → project the baby's own gain rate (g/day, from the two
//     most recent) forward to `at`;
//   • 1 weigh-in    → project age-based velocity forward from it;
//   • 0 weigh-ins   → null (caller falls back to the stored static target).
// Never assumes weight loss (rate floored at 0) and caps the projection window
// at MAX_PROJECTION_DAYS so a months-old measurement can't run away.
export function estimateWeightG(
  samples: WeightSample[],
  at: Date,
  dob: string | null
): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a.ts.localeCompare(b.ts));
  const latest = sorted[sorted.length - 1];
  const latestMs = Date.parse(latest.ts);
  const projDays = Math.min(
    Math.max((at.getTime() - latestMs) / DAY_MS, 0),
    MAX_PROJECTION_DAYS
  );

  let ratePerDay: number;
  if (sorted.length >= 2) {
    const prev = sorted[sorted.length - 2];
    const days = (latestMs - Date.parse(prev.ts)) / DAY_MS;
    ratePerDay = days > 0 ? (latest.weight_g - prev.weight_g) / days : 0;
  } else {
    const ageAtLatest = dob
      ? computeAgeParts(dob, new Date(latestMs))?.days ?? 0
      : 0;
    ratePerDay = ageWeightVelocityGPerDay(ageAtLatest);
  }
  ratePerDay = Math.max(0, Math.min(ratePerDay, MAX_TREND_G_PER_DAY));
  return latest.weight_g + ratePerDay * projDays;
}

export type IndicationMetricName =
  | "feeding_total_ml"
  | "feeding_count"
  | "feeding_gap_max_min"
  | "diaper_count"
  | "routine_count"
  | "note_count";

// Inputs a formula draws on. Either can be null (no weigh-in yet / no DOB set),
// in which case a formula that needs it returns null and the caller falls back.
export type GrowthContext = {
  estWeightG: number | null;
  ageDays: number | null;
};

export type GrowthFormula = {
  metric: IndicationMetricName;
  comparison: ">=" | "<=";
  filter: string | null;
  label: string;
  // Stored in the `target` column and used whenever compute() returns null
  // (missing weight/age), so a formula row is never left without a threshold.
  fallbackTarget: number;
  compute: (ctx: GrowthContext) => number | null;
};

const round10 = (n: number) => Math.round(n / 10) * 10;

// The known formula keys, as a tuple so callers can build a zod enum from it.
export const GROWTH_FORMULA_KEYS = [
  "milk_ml_per_kg_day",
  "feeds_per_day",
  "feed_gap_max_by_age",
  "poops_per_day_by_age",
] as const;

export type GrowthFormulaKey = (typeof GROWTH_FORMULA_KEYS)[number];

// The catalog of progression formulas. The key is stored in indications.formula;
// its metric/comparison/filter must match the row's own columns (the seed and
// add_indication enforce this) so evaluation aggregates the right data.
export const GROWTH_FORMULAS: Record<GrowthFormulaKey, GrowthFormula> = {
  // 150 ml/kg/day is the standard formula-feeding requirement; capped at
  // 960 ml/day (~32 oz), the usual daily ceiling before solids take over.
  milk_ml_per_kg_day: {
    metric: "feeding_total_ml",
    comparison: ">=",
    filter: null,
    label: "Milk ≥ 150 ml/kg",
    fallbackTarget: 600,
    compute: ({ estWeightG }) =>
      estWeightG == null
        ? null
        : round10(Math.min((150 * estWeightG) / 1000, 960)),
  },
  // Feeds taper as the stomach grows: 8/day newborn → 4/day past 6 months.
  feeds_per_day: {
    metric: "feeding_count",
    comparison: ">=",
    filter: null,
    label: "Feeds/day",
    fallbackTarget: 6,
    compute: ({ ageDays }) =>
      ageDays == null
        ? null
        : ageDays < 28
          ? 8
          : ageDays < 60
            ? 7
            : ageDays < 120
              ? 6
              : ageDays < 180
                ? 5
                : 4,
  },
  // Don't let a newborn go too long between feeds (weight gain / jaundice /
  // hypoglycemia); the cap relaxes as the baby matures. Minutes.
  feed_gap_max_by_age: {
    metric: "feeding_gap_max_min",
    comparison: "<=",
    filter: null,
    label: "Max feed gap",
    fallbackTarget: 300,
    compute: ({ ageDays }) =>
      ageDays == null ? null : ageDays < 28 ? 240 : ageDays < 90 ? 300 : 360,
  },
  // Newborns typically stool more; ≥1/day from ~6 weeks on.
  poops_per_day_by_age: {
    metric: "diaper_count",
    comparison: ">=",
    filter: "poop",
    label: "Poops/day",
    fallbackTarget: 1,
    compute: ({ ageDays }) => (ageDays == null ? null : ageDays < 42 ? 2 : 1),
  },
};

export function isGrowthFormula(
  key: string | null | undefined
): key is GrowthFormulaKey {
  return typeof key === "string" && key in GROWTH_FORMULAS;
}

// Resolve the effective target for an indication: a growth formula's computed
// value when present and computable, otherwise the stored static target.
export function resolveIndicationTarget(
  ind: { formula: string | null; target: number },
  ctx: GrowthContext
): number {
  if (!isGrowthFormula(ind.formula)) return ind.target;
  const computed = GROWTH_FORMULAS[ind.formula].compute(ctx);
  return computed == null ? ind.target : computed;
}

// Age in whole days from a DOB at instant `at`, or null (no DOB / not yet born).
export function ageDaysAt(dob: string | null, at: Date): number | null {
  if (!dob) return null;
  return computeAgeParts(dob, at)?.days ?? null;
}
