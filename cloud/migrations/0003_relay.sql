-- Relay logins handed out (to limit how many a PC can ask for), kept for an hour.
CREATE TABLE IF NOT EXISTS turn_log (
  device_id INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS turn_log_device ON turn_log(device_id, at);
