-- Diapers: one row per diaper change.
-- kind = 'pee' (wet only), 'poop' (dirty only), or 'both'.
CREATE TABLE IF NOT EXISTS diapers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('pee', 'poop', 'both')),
  note        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_diapers_ts   ON diapers(ts);
CREATE INDEX IF NOT EXISTS idx_diapers_kind ON diapers(kind);
