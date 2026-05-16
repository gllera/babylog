-- Allow `feeding_gap_max_min` as an indication metric: the max gap (minutes)
-- between consecutive feedings in the window. Typically used with comparison
-- '<=' to enforce "no more than X minutes between feedings".
-- SQLite can't ALTER a CHECK constraint in place, so we recreate the table.

CREATE TABLE indications_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  label        TEXT    NOT NULL,
  metric       TEXT    NOT NULL CHECK (metric IN (
                 'feeding_total_ml',
                 'feeding_count',
                 'feeding_gap_max_min',
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
  SELECT id, label, metric, filter, target, comparison, period_days, active, created_at
  FROM indications;

DROP TABLE indications;
ALTER TABLE indications_new RENAME TO indications;

CREATE INDEX IF NOT EXISTS idx_indications_active ON indications(active);
