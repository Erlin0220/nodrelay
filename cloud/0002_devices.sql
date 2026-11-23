CREATE TABLE IF NOT EXISTS fleet_devices (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  unique_name TEXT NOT NULL UNIQUE,
  tunnel_id TEXT,
  credentials TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fleet_leases (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
