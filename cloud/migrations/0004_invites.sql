-- Invite links (one-time links that let someone without an account join a stream).
ALTER TABLE users ADD COLUMN guest INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  host_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_device INTEGER NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  status TEXT NOT NULL,
  claimed INTEGER,
  guest_user INTEGER,
  guest_device INTEGER
);
CREATE INDEX IF NOT EXISTS invites_host ON invites(host_user, status);
CREATE INDEX IF NOT EXISTS invites_guest ON invites(guest_user);
