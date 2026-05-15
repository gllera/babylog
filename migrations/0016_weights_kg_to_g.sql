-- Switch the weights column from kilograms (REAL) to whole grams.
-- SQLite's RENAME COLUMN auto-updates the existing CHECK (weight_kg > 0) constraint.

ALTER TABLE weights RENAME COLUMN weight_kg TO weight_g;

UPDATE weights SET weight_g = ROUND(weight_g * 1000);
