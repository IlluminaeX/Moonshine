-- Direct connections, for a database made before them.
-- Apply once: npx wrangler d1 execute moonshine --remote --file=migrations/0001_tunnel.sql
ALTER TABLE devices ADD COLUMN tunnel INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS hub_tickets (
  ticket TEXT PRIMARY KEY,
  device_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created INTEGER NOT NULL
);
