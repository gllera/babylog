-- Caregiver invites: a pending, explicitly-accepted membership offer.
-- add_caregiver no longer inserts into users directly — that silently claimed
-- the email (a typo would block its real owner from ever creating their own
-- household). It creates an invite instead; the invitee sees it on /welcome
-- after magic-link login (which proves email ownership) and accepting it
-- inserts the users row.
CREATE TABLE invites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id  INTEGER NOT NULL,
  email         TEXT    NOT NULL,               -- stored lowercased
  invited_by    TEXT,                           -- inviter's email, shown on /welcome
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (household_id, email)
);

CREATE INDEX idx_invites_email ON invites(email);
