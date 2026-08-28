CREATE TABLE IF NOT EXISTS ubeeq_accounts (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ubeeq_sessions (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES ubeeq_accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ubeeq_sessions_active ON ubeeq_sessions (token_hash, expires_at) WHERE revoked_at IS NULL;
