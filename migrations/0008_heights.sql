-- Heights: one row per length/height measurement.
-- height_cm is the measured length in centimeters (babies are measured lying down,
-- so "length" is technically more accurate, but we call it height for convenience).
CREATE TABLE IF NOT EXISTS heights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  height_cm   REAL    NOT NULL CHECK (height_cm > 0),
  note        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_heights_ts ON heights(ts);
