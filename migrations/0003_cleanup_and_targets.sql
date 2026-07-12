-- The unreleased 2026-07-11 batch, squashed into one file (repo convention —
-- 0001 is itself a squashed baseline): retire the 'both' diaper kind, remove
-- notes, and curate the Today targets. Every statement is exact-match,
-- guarded or IF EXISTS, so the file is safe on any database state — the dev
-- DB, which ran the original unsquashed files under their old names,
-- re-runs this with no effect beyond a harmless identical diapers rebuild.

-- Retire the 'both' diaper kind: a wet+dirty change is recorded as 'poop'
-- from now on (a poop diaper is virtually always wet too), so existing
-- 'both' rows become 'poop'. SQLite cannot alter a CHECK constraint, so the
-- table is rebuilt to tighten it to ('pee','poop'). Copying explicit ids
-- keeps history stable and carries the AUTOINCREMENT sequence forward
-- through the rename.
UPDATE diapers SET kind = 'poop' WHERE kind = 'both';

CREATE TABLE diapers_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('pee', 'poop')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  baby_id     INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT
);

INSERT INTO diapers_new (id, ts, kind, created_at, baby_id, created_by)
  SELECT id, ts, kind, created_at, baby_id, created_by FROM diapers;

DROP TABLE diapers;
ALTER TABLE diapers_new RENAME TO diapers;

CREATE INDEX idx_diapers_ts      ON diapers(ts);
CREATE INDEX idx_diapers_kind    ON diapers(kind);
CREATE INDEX idx_diapers_baby_ts ON diapers(baby_id, ts);

-- Notes removed as a feature: the web UI, REST API, and MCP tools no longer
-- read or write them. Drop the recorded notes and any note_count
-- indications, which nothing can evaluate anymore. (The indications.metric
-- CHECK in 0001 still lists 'note_count' — SQLite cannot amend a CHECK
-- without rebuilding the table. That leftover is permissive, not blocking:
-- application code no longer accepts the value.)
DELETE FROM indications WHERE metric = 'note_count';

DROP TABLE IF EXISTS notes;

-- Targets, retired: the household no longer tracks feed count or the
-- longest gap between feedings. The gap goes by metric (gap targets only
-- ever meant this rule); the count by its formula — feeding_count is a
-- general-purpose metric a custom target could use. The metrics and
-- formulas themselves stay supported, so either can be re-added later via
-- the MCP tool.
DELETE FROM indications WHERE metric = 'feeding_gap_max_min';
DELETE FROM indications WHERE formula = 'feeds_per_day';

-- Targets, renamed: the Today ribbon shows each target as a minimal chip
-- (name + score) and spells the full rule out in a tap caption composed
-- from the structured columns, so a label's only job now is to name the
-- thing being tracked ('Vitamin', not 'Vitamin D/day' — and just 'Vitamin':
-- there's only one vitamin in the house). Exact-match renames of the known
-- descriptive labels — anything the user customized, and the deactivated
-- relics, keep their history.
UPDATE indications SET label = 'Milk'    WHERE label = 'Milk ≥ 150 ml/kg';
UPDATE indications SET label = 'Poops'   WHERE label = 'Poops/day';
UPDATE indications SET label = 'Pees'    WHERE label = 'Pees/day';
UPDATE indications SET label = 'Vitamin' WHERE label IN ('Vitamin D/day', 'Vitamin D');
UPDATE indications SET label = 'Bath'    WHERE label = 'Bath/2 days';

-- Targets, seeded: the three the household added by hand — so a fresh
-- database matches the real regimen, not just 0002's formula seeds — plus
-- tummy time, its second most-logged routine but until now the only
-- regularly-logged one without a rule (one session a day per the standard
-- guidance; currently hit about every other day — the open chip is the
-- nudge). Values copied from the production rows, labels in the bare-name
-- style. Each insert is guarded on the target's semantic identity (metric +
-- filter for baby #1) rather than its label, so it stays a no-op on
-- databases that already track the same thing — even renamed or
-- deactivated — and never duplicates or resurrects anything.
INSERT INTO indications (label, metric, filter, target, comparison, period_days, baby_id)
SELECT 'Pees', 'diaper_count', 'pee', 6, '>=', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM indications
                  WHERE baby_id = 1 AND metric = 'diaper_count' AND filter = 'pee');

INSERT INTO indications (label, metric, filter, target, comparison, period_days, baby_id)
SELECT 'Vitamin', 'routine_count', 'vitamin d', 1, '>=', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM indications
                  WHERE baby_id = 1 AND metric = 'routine_count' AND filter = 'vitamin d');

INSERT INTO indications (label, metric, filter, target, comparison, period_days, baby_id)
SELECT 'Bath', 'routine_count', 'bath', 1, '>=', 2, 1
WHERE NOT EXISTS (SELECT 1 FROM indications
                  WHERE baby_id = 1 AND metric = 'routine_count' AND filter = 'bath');

INSERT INTO indications (label, metric, filter, target, comparison, period_days, baby_id)
SELECT 'Tummy', 'routine_count', 'tummy', 1, '>=', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM indications
                  WHERE baby_id = 1 AND metric = 'routine_count' AND filter = 'tummy');
