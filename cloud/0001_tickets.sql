CREATE TABLE IF NOT EXISTS enrollment_tickets (
  digest TEXT PRIMARY KEY,
  device_id TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  iv TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS enrollment_tickets_expiry ON enrollment_tickets (expires_at);
