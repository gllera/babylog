-- Update the CHECK constraint on indications.metric to reflect the renames:
--   medication_count  → routine_count
--   observation_count → note_count
-- SQLite can't ALTER a CHECK constraint in place, so recreate the table.

CREATE TABLE indications_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  label        TEXT    NOT NULL,
  metric       TEXT    NOT NULL CHECK (metric IN (
                 'feeding_total_ml',
                 'feeding_count',
                 'diaper_count',
                 'routine_count',
                 'note_count'
               )),
  filter       TEXT,
  target       REAL    NOT NULL,
  comparison   TEXT    NOT NULL DEFAULT '>=' CHECK (comparison IN ('>=','<=')),
  period_days  INTEGER NOT NULL DEFAULT 1 CHECK (period_days > 0),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO indications_new
  (id, label, metric, filter, target, comparison, period_days, active, created_at)
  SELECT
    id,
    label,
    CASE metric
      WHEN 'medication_count'  THEN 'routine_count'
      WHEN 'observation_count' THEN 'note_count'
      ELSE metric
    END,
    CASE
      WHEN metric = 'medication_count' AND filter = 'vitamina d' THEN 'vitamin d'
      WHEN metric = 'medication_count' AND filter = 'baño'       THEN 'bath'
      ELSE filter
    END,
    target, comparison, period_days, active, created_at
  FROM indications;

DROP TABLE indications;
ALTER TABLE indications_new RENAME TO indications;

CREATE INDEX IF NOT EXISTS idx_indications_active ON indications(active);
