# Growth-based "Today's targets" — design

**Date:** 2026-07-08
**Status:** approved (implementing)

## Problem

"Today's targets" renders the `indications` table — daily care targets like "1
poop a day" or "max 4h between feedings". Each indication stores a **fixed**
`target` number. A newborn's realistic milk intake, feed frequency, and safe
feeding gap all change week to week, so a static number is either wrong soon
after it's set or has to be edited by hand. We want targets that **progress
automatically with the baby's weight and age**.

## Approach

Dynamic, auto-computed targets. Add a nullable `formula` column to
`indications`. When `formula` is set, the server computes the effective
`target` live from the baby's **estimated current weight** and **age** at
evaluation time and ignores the stored number; when it's `NULL`, indications
behave exactly as today. All existing plumbing — the `actual`/`met`/`over`
logic, the "Today's targets" card, MCP `check_indications`, `list_indications`
— is reused unchanged; only the target number becomes computed.

Rejected alternatives: pre-seeded age bands (stepwise, needs manual/cron
swapping, ignores actual weight) and a one-time computed seed (freezes,
defeats the point). A separate targets subsystem was rejected as duplicating
the evaluation/UI machinery for no gain.

## Weight estimation (hybrid)

Real weigh-ins are infrequent, so between them we project the weight forward:

- **≥2 weigh-ins** → project the baby's **own** gain rate (g/day from the two
  most recent) forward to today.
- **1 weigh-in** → project **age-based velocity** off it (~200 g/wk at 0–3mo,
  ~150 at 3–6mo, ~85 at 6–12mo, ~40 after).
- **0 weigh-ins** → `null`; weight-based targets fall back to their stored
  static value.

Guards: projected rate is floored at 0 (never assume weight loss) and capped
at 60 g/day (noise); projection horizon capped at 60 days so a stale weigh-in
can't run away. Recomputed on every dashboard load, so weekly weigh-ins keep it
sharp.

## Formulas (the progression)

Formula-fed / bottle assumption (the app records `amount_ml` per feeding, and
150 ml/kg/day is the formula-feeding standard).

| Formula key | Metric | Rule |
|---|---|---|
| `milk_ml_per_kg_day` | `feeding_total_ml` ≥ | `150 ml/kg/day × est. weight`, capped **960 ml**, rounded to 10 |
| `feeds_per_day` | `feeding_count` ≥ | 0–4wk **8** · 1–2mo **7** · 2–4mo **6** · 4–6mo **5** · 6mo+ **4** |
| `feed_gap_max_by_age` | `feeding_gap_max_min` ≤ | 0–4wk **240** · 1–3mo **300** · 3mo+ **360** (min) |
| `poops_per_day_by_age` | `diaper_count`(poop) ≥ | 0–6wk **2** · 6wk+ **1** |

Age bands are in days: `<28`, `<60`, `<90`, `<120`, `<180`, `<365`.

## Components

- **`src/growth.ts`** (new, pure): `estimateWeightG`, `ageWeightVelocityGPerDay`,
  the `GROWTH_FORMULAS` registry, and `resolveIndicationTarget`.
- **`migrations/0002_indication_formula.sql`**: `ALTER TABLE indications ADD
  COLUMN formula TEXT`, plus a guarded seed of the four formula rows for the
  default baby (`WHERE NOT EXISTS` on the same formula, so it's a no-op on
  re-application and never duplicates).
- **`src/api.ts`** `handleDashboard`: select `formula`, compute est. weight +
  age, resolve each target before `met`, add `est_weight_g` to the payload.
- **`src/tools.ts`**: `IndicationRow` gains `formula`; `check_indications`
  fetches weights and resolves formula targets; `list_indications` selects and
  shows `formula`; `add_indication` gains an optional `formula` param
  (validated consistent with `metric`).
- **`src/app.html`** `renderTargets`: when a row is `milk_ml_per_kg_day`, append
  `· est X.XX kg` so the computed number is transparent, not magic.

## Testing

`test/growth.test.ts` (vitest, pure): weight estimator (own-trend, single-sample
fallback, no-data null, loss-clamp, horizon cap), each formula across age/weight
points, and `resolveIndicationTarget` fallback when the formula can't compute.

## Out of scope

Breastfed (non-volume) milk targets, per-baby formula overrides beyond the
default baby's seed, and a web UI for editing indications (still MCP-only).
