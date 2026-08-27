CREATE TABLE IF NOT EXISTS ubeeq_federation_keys (
  id TEXT PRIMARY KEY,
  private_key TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
