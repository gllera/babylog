-- Multi-user support: households (tenants) → users (caregivers) → babies.
-- Every event table gains baby_id + created_by; the singleton profile table
-- becomes babies row #1 under household #1.
-- Numbering jumps 0017 → 0020: prod already consumed 0018/0019 for the
-- removed sleep-tracking feature.

CREATE TABLE IF NOT EXISTS households (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,             -- stored lowercased
  household_id  INTEGER NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS babies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id   INTEGER NOT NULL,
  name           TEXT,
  sex            TEXT    CHECK (sex IS NULL OR sex IN ('male','female','other')),
  date_of_birth  TEXT,                               -- ISO date YYYY-MM-DD
  is_default     INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_babies_household ON babies(household_id);

INSERT OR IGNORE INTO households (id, name) VALUES (1, 'Home');
INSERT OR IGNORE INTO users (email, household_id)
  VALUES ('gabriellleragarcia@gmail.com', 1);

-- The singleton profile becomes baby #1 (the household default).
INSERT OR IGNORE INTO babies (id, household_id, name, sex, date_of_birth, is_default)
  SELECT 1, 1, name, sex, date_of_birth, 1 FROM profile WHERE id = 1;
-- Safety net for a DB whose profile row went missing.
INSERT OR IGNORE INTO babies (id, household_id, is_default) VALUES (1, 1, 1);

DROP TABLE profile;

ALTER TABLE feedings ADD COLUMN baby_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE feedings ADD COLUMN created_by TEXT;
CREATE INDEX IF NOT EXISTS idx_feedings_baby_ts ON feedings(baby_id, ts);

ALTER TABLE diapers ADD COLUMN baby_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE diapers ADD COLUMN created_by TEXT;
CREATE INDEX IF NOT EXISTS idx_diapers_baby_ts ON diapers(baby_id, ts);

ALTER TABLE routines ADD COLUMN baby_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE routines ADD COLUMN created_by TEXT;
CREATE INDEX IF NOT EXISTS idx_routines_baby_ts ON routines(baby_id, ts);

ALTER TABLE notes ADD COLUMN baby_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notes ADD COLUMN created_by TEXT;
CREATE INDEX IF NOT EXISTS idx_notes_baby_ts ON notes(baby_id, ts);

ALTER TABLE weights ADD COLUMN baby_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE weights ADD COLUMN created_by TEXT;
CREATE INDEX IF NOT EXISTS idx_weights_baby_ts ON weights(baby_id, ts);

ALTER TABLE heights ADD COLUMN baby_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE heights ADD COLUMN created_by TEXT;
CREATE INDEX IF NOT EXISTS idx_heights_baby_ts ON heights(baby_id, ts);

ALTER TABLE indications ADD COLUMN baby_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE indications ADD COLUMN created_by TEXT;
