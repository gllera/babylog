-- Observations: free-form notes about the baby that don't fit feedings,
-- diapers, or medications. Examples: 'pimples on the face', 'fussy after nap',
-- 'first smile', 'rash on left arm'. Optional category for grouping.
CREATE TABLE IF NOT EXISTS observations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  category    TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_observations_ts       ON observations(ts);
CREATE INDEX IF NOT EXISTS idx_observations_category ON observations(category);
