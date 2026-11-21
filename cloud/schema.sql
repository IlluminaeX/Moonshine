-- Moonshine friends service (Cloudflare D1).
-- Apply: npx wrangler d1 execute moonshine --remote --file=schema.sql

-- A person. Signed in with Discord, so they can get their username back on another PC.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL UNIQUE,
  username TEXT,
  username_lower TEXT UNIQUE,
  created INTEGER NOT NULL
);

-- A PC signed in as that person. Authenticates with a random token (only its hash is kept here).
-- The rest is what it last reported: how friends can reach its host, and whether it's busy.
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  host_uuid TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 47989,
  addrs TEXT NOT NULL DEFAULT '[]',
  public_ip TEXT NOT NULL DEFAULT '',
  hosting INTEGER NOT NULL DEFAULT 0,
  busy INTEGER NOT NULL DEFAULT 0,
  guests INTEGER NOT NULL DEFAULT 0,
  tunnel INTEGER NOT NULL DEFAULT 0, -- connected to the live link, so it can take direct connections
  version TEXT NOT NULL DEFAULT '', -- its Moonshine version ('' = older than 0.3.0)
  game TEXT NOT NULL DEFAULT '', -- what it's playing or hosting, if its owner shares that
  last_seen INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id);

-- Friendships. `a` asked `b`; status is 'pending' until b accepts, then 'accepted'.
CREATE TABLE IF NOT EXISTS friends (
  a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS friends_b ON friends(b);

-- A name you gave a friend; only you see it.
CREATE TABLE IF NOT EXISTS nicknames (
  owner INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nick TEXT NOT NULL,
  PRIMARY KEY (owner, friend)
);

-- When each quick message was sent (not what it said), to limit how many a person sends.
CREATE TABLE IF NOT EXISTS message_log (
  sender INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS message_log_sender ON message_log(sender, at);

-- Sign-ins in progress: the app opens the browser with a random session and polls for its token.
CREATE TABLE IF NOT EXISTS logins (
  session TEXT PRIMARY KEY,
  created INTEGER NOT NULL,
  token TEXT,
  error TEXT
);

-- One-time passes for a PC to open its live link (a WebSocket can't carry the sign-in header).
CREATE TABLE IF NOT EXISTS hub_tickets (
  ticket TEXT PRIMARY KEY,
  device_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created INTEGER NOT NULL
);
