CREATE TABLE IF NOT EXISTS ubeeq_credentials (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  auth_tag BLOB NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
