-- Single-use markers for Alexa account-linking authorization codes.
-- /auth/alexa/token INSERTs the code's jti on redemption; a UNIQUE conflict
-- means replay. Codes expire in 60s, rows are purged opportunistically after
-- a day, so this table never holds more than a handful of rows.
CREATE TABLE alexa_link_codes (
  jti     TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
);
