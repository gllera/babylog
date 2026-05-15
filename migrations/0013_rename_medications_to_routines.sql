DROP INDEX IF EXISTS idx_medications_ts;
DROP INDEX IF EXISTS idx_medications_name;

ALTER TABLE medications RENAME TO routines;

CREATE INDEX IF NOT EXISTS idx_routines_ts   ON routines(ts);
CREATE INDEX IF NOT EXISTS idx_routines_name ON routines(name);

UPDATE routines SET name = 'Vitamin D' WHERE name = 'Vitamina D';
UPDATE routines SET name = 'Bath'      WHERE name = 'Baño';
