CREATE TABLE IF NOT EXISTS enrollment_intents (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL,
  code_digest TEXT NOT NULL UNIQUE,
  code_ciphertext TEXT,
  snapshot TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'revoked')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  recovery_digest TEXT,
  claimed_architecture TEXT,
  CHECK ((state = 'pending' AND code_ciphertext IS NOT NULL AND resolved_at IS NULL)
      OR (state <> 'pending' AND code_ciphertext IS NULL AND resolved_at IS NOT NULL)),
  CHECK ((state = 'claimed' AND recovery_digest IS NOT NULL AND claimed_architecture IN ('x64', 'arm64') AND claimed_architecture IS NOT NULL)
      OR (state <> 'claimed' AND recovery_digest IS NULL AND claimed_architecture IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS enrollment_intents_pending_device
  ON enrollment_intents (device_id) WHERE state = 'pending';
