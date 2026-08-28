CREATE TABLE IF NOT EXISTS ubeeq_federation_replays (
  id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
