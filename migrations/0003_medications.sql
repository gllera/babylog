-- Medications: one row per dose given to the baby.
-- name is the medication name (e.g. 'Vitamin D', 'Acetaminophen').
-- dose is free-form (e.g. '400 IU', '1 drop', '2.5 ml') because units vary by drug.
CREATE TABLE IF NOT EXISTS medications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  dose        TEXT,
  note        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_medications_ts   ON medications(ts);
CREATE INDEX IF NOT EXISTS idx_medications_name ON medications(name);
