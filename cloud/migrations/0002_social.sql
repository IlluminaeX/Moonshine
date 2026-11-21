-- Versions, what friends are playing, nicknames and quick messages, for a database made before them.
-- Apply once: npx wrangler d1 execute moonshine --remote --file=migrations/0002_social.sql
ALTER TABLE devices ADD COLUMN version TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN game TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS nicknames (
  owner INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nick TEXT NOT NULL,
  PRIMARY KEY (owner, friend)
);
CREATE TABLE IF NOT EXISTS message_log (
  sender INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS message_log_sender ON message_log(sender, at);
