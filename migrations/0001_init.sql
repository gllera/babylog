-- Feedings: one row per recorded milk feeding.
-- ts is the time the baby drank (ISO 8601 UTC string).
-- amount_ml is the volume consumed in milliliters.
CREATE TABLE IF NOT EXISTS feedings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  amount_ml   REAL    NOT NULL CHECK (amount_ml > 0),
  note        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedings_ts ON feedings(ts);
