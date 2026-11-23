CREATE TABLE IF NOT EXISTS management_upgrade_journal (
  target TEXT PRIMARY KEY NOT NULL,
  record TEXT NOT NULL
);
