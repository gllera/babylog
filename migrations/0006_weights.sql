-- Weights: one row per weight measurement.
-- weight_kg is the measured weight in kilograms.
CREATE TABLE IF NOT EXISTS weights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  weight_kg   REAL    NOT NULL CHECK (weight_kg > 0),
  note        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_weights_ts ON weights(ts);
