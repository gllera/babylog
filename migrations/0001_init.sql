-- Consolidated baseline schema for babylog.
--
-- This single migration replaces the original 0001..0020 history (squashed
-- 2026-07-07). D1 tracks applied migrations by filename, so any database that
-- already ran the old chain (e.g. production `baby-feedings`) has this exact
-- filename recorded and skips it — its data is untouched. A fresh database
-- runs this file alone and lands on the identical final schema plus the
-- bootstrap rows below.
--
-- The old chain also carried one-off data transforms (weight kg→g, table
-- renames, indication metric renames); those only matter to a database that
-- held pre-transform rows, so they are intentionally dropped here.

-- Households (the tenancy unit): all caregivers in a household share its data.
CREATE TABLE households (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Users: an authenticated email (as verified by Cloudflare Access), stored
-- lowercased, belonging to exactly one household.
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,             -- stored lowercased
  household_id  INTEGER NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Babies: each household has one or more; exactly one is the default.
CREATE TABLE babies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id   INTEGER NOT NULL,
  name           TEXT,
  sex            TEXT    CHECK (sex IS NULL OR sex IN ('male','female','other')),
  date_of_birth  TEXT,                               -- ISO date YYYY-MM-DD
  is_default     INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_babies_household ON babies(household_id);

-- Feedings: one row per recorded milk feeding.
-- ts is the time the baby drank (ISO 8601 UTC string).
-- amount_ml is the volume consumed in milliliters.
CREATE TABLE feedings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  amount_ml   REAL    NOT NULL CHECK (amount_ml > 0),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  baby_id     INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT
);

CREATE INDEX idx_feedings_ts      ON feedings(ts);
CREATE INDEX idx_feedings_baby_ts ON feedings(baby_id, ts);

-- Diapers: one row per diaper change.
-- kind = 'pee' (wet only), 'poop' (dirty only), or 'both'.
CREATE TABLE diapers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('pee', 'poop', 'both')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  baby_id     INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT
);

CREATE INDEX idx_diapers_ts      ON diapers(ts);
CREATE INDEX idx_diapers_kind    ON diapers(kind);
CREATE INDEX idx_diapers_baby_ts ON diapers(baby_id, ts);

-- Routines: one row per routine event given to the baby (e.g. 'Vitamin D',
-- 'Bath'). name is free-form.
CREATE TABLE routines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  baby_id     INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT
);

CREATE INDEX idx_routines_ts      ON routines(ts);
CREATE INDEX idx_routines_name    ON routines(name);
CREATE INDEX idx_routines_baby_ts ON routines(baby_id, ts);

-- Notes: free-form observations about the baby that don't fit the other
-- event types (e.g. 'first smile', 'rash on left arm').
CREATE TABLE notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  baby_id     INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT
);

CREATE INDEX idx_notes_ts      ON notes(ts);
CREATE INDEX idx_notes_baby_ts ON notes(baby_id, ts);

-- Weights: one row per weight measurement. weight_g is whole grams.
CREATE TABLE weights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  weight_g    REAL    NOT NULL CHECK (weight_g > 0),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  baby_id     INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT
);

CREATE INDEX idx_weights_ts      ON weights(ts);
CREATE INDEX idx_weights_baby_ts ON weights(baby_id, ts);

-- Heights: one row per length/height measurement. height_cm is centimeters.
CREATE TABLE heights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  height_cm   REAL    NOT NULL CHECK (height_cm > 0),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  baby_id     INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT
);

CREATE INDEX idx_heights_ts      ON heights(ts);
CREATE INDEX idx_heights_baby_ts ON heights(baby_id, ts);

-- Indications: daily/periodic targets for the baby's care.
-- `metric` chooses which recorded data to aggregate over the window.
-- `filter` narrows the metric (e.g. 'poop' for diaper_count, a routine name
-- substring for routine_count). `period_days` sets the window length.
CREATE TABLE indications (
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
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  baby_id      INTEGER NOT NULL DEFAULT 1,
  created_by   TEXT
);

CREATE INDEX idx_indications_active ON indications(active);

-- Bootstrap seed: household #1 with the owner and one default baby. There is
-- no self-serve signup, so a fresh database needs at least one user/household/
-- baby or every authenticated request would 403. OR IGNORE keeps this a no-op
-- on a database that already has these rows.
INSERT OR IGNORE INTO households (id, name) VALUES (1, 'Home');
INSERT OR IGNORE INTO users (email, household_id)
  VALUES ('gabriellleragarcia@gmail.com', 1);
INSERT OR IGNORE INTO babies (id, household_id, is_default) VALUES (1, 1, 1);
