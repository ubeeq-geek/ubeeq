CREATE TABLE IF NOT EXISTS ubeeq_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ubeeq_records (
  repository TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (repository, id)
);

CREATE INDEX IF NOT EXISTS ubeeq_records_repository_id ON ubeeq_records (repository, id);

CREATE TABLE IF NOT EXISTS ubeeq_idempotency (
  repository TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  record_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (repository, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ubeeq_jobs (
  id UUID PRIMARY KEY,
  cell_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  available_at TIMESTAMPTZ NOT NULL,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  correlation_id TEXT,
  last_error JSONB,
  UNIQUE (cell_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ubeeq_jobs_lease ON ubeeq_jobs (cell_id, state, available_at);
