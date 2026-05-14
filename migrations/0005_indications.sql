-- Indications: daily targets that the baby's care should follow.
-- Each row is a rule, e.g. "1 poop a day" or "≥500 ml of milk a day".
-- `metric` chooses which recorded data to aggregate over a day window.
-- `filter` narrows the metric:
--    diaper_count     → 'pee' | 'poop' | 'both' | NULL (any diaper event)
--    medication_count → case-insensitive substring of medications.name | NULL (any med)
--    feeding_*        → ignored
CREATE TABLE IF NOT EXISTS indications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT    NOT NULL,
  metric      TEXT    NOT NULL CHECK (metric IN (
                'feeding_total_ml',
                'feeding_count',
                'diaper_count',
                'medication_count'
              )),
  filter      TEXT,
  target      REAL    NOT NULL,
  comparison  TEXT    NOT NULL DEFAULT '>=' CHECK (comparison IN ('>=','<=')),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  note        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_indications_active ON indications(active);
