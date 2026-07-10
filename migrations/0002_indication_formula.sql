-- Growth-based "Today's targets": an indication whose `formula` is non-NULL has
-- its `target` computed live from the baby's estimated weight and age at
-- evaluation time (see src/growth.ts); the stored `target` is only a fallback
-- for when weight/age are unavailable. NULL `formula` keeps the old static
-- behavior, so this column is additive and every existing indication is
-- untouched.
ALTER TABLE indications ADD COLUMN formula TEXT;

-- Seed the four progression targets for the default baby (#1). Each insert is
-- guarded by NOT EXISTS on its own formula, so applying this file to a database
-- that already has them (or re-running it) is a no-op and never duplicates.
-- Stored `target` values here are the fallbacks used only when weight/age are
-- missing; the live numbers come from growth.ts.
INSERT INTO indications (label, metric, filter, target, comparison, period_days, baby_id, formula)
SELECT 'Milk ≥ 150 ml/kg', 'feeding_total_ml', NULL, 600, '>=', 1, 1, 'milk_ml_per_kg_day'
WHERE NOT EXISTS (SELECT 1 FROM indications WHERE baby_id = 1 AND formula = 'milk_ml_per_kg_day');

INSERT INTO indications (label, metric, filter, target, comparison, period_days, baby_id, formula)
SELECT 'Feeds/day', 'feeding_count', NULL, 6, '>=', 1, 1, 'feeds_per_day'
WHERE NOT EXISTS (SELECT 1 FROM indications WHERE baby_id = 1 AND formula = 'feeds_per_day');

INSERT INTO indications (label, metric, filter, target, comparison, period_days, baby_id, formula)
SELECT 'Max feed gap', 'feeding_gap_max_min', NULL, 300, '<=', 1, 1, 'feed_gap_max_by_age'
WHERE NOT EXISTS (SELECT 1 FROM indications WHERE baby_id = 1 AND formula = 'feed_gap_max_by_age');

INSERT INTO indications (label, metric, filter, target, comparison, period_days, baby_id, formula)
SELECT 'Poops/day', 'diaper_count', 'poop', 1, '>=', 1, 1, 'poops_per_day_by_age'
WHERE NOT EXISTS (SELECT 1 FROM indications WHERE baby_id = 1 AND formula = 'poops_per_day_by_age');
