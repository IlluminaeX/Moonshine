-- Do not disturb shows as a red ring on a friend's picture, and a PC renamed on one of your devices keeps
-- its new name on the others.
ALTER TABLE devices ADD COLUMN dnd INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS pc_names (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_uuid TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (user_id, host_uuid)
);
