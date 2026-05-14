-- Profile: a single-row table holding identifying info about the baby.
-- The CHECK constraint plus the seeded row enforce a singleton.
CREATE TABLE IF NOT EXISTS profile (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  name           TEXT,
  sex            TEXT    CHECK (sex IS NULL OR sex IN ('male','female','other')),
  date_of_birth  TEXT,                                -- ISO date YYYY-MM-DD
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO profile (id) VALUES (1);
