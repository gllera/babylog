DROP INDEX IF EXISTS idx_observations_ts;

ALTER TABLE observations RENAME TO notes;

CREATE INDEX IF NOT EXISTS idx_notes_ts ON notes(ts);
