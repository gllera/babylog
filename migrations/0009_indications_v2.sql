-- Generalize indications:
--   * Allow `observation_count` as a metric (so observations.category like 'bath' work).
--   * Add `period_days` (default 1) so windows can span N days, e.g. "bath every 2 days".
-- SQLite can't ALTER a CHECK constraint in place, so we recreate the table.

CREATE TABLE indications_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  label        TEXT    NOT NULL,
  metric       TEXT    NOT NULL CHECK (metric IN (
                 'feeding_total_ml',
                 'feeding_count',
                 'diaper_count',
                 'medication_count',
                 'observation_count'
               )),
  filter       TEXT,
  target       REAL    NOT NULL,
  comparison   TEXT    NOT NULL DEFAULT '>=' CHECK (comparison IN ('>=','<=')),
  period_days  INTEGER NOT NULL DEFAULT 1 CHECK (period_days > 0),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  note         TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO indications_new
  (id, label, metric, filter, target, comparison, period_days, active, note, created_at)
  SELECT id, label, metric, filter, target, comparison, 1, active, note, created_at
  FROM indications;

DROP TABLE indications;
ALTER TABLE indications_new RENAME TO indications;

CREATE INDEX IF NOT EXISTS idx_indications_active ON indications(active);
