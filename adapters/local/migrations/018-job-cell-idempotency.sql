CREATE TABLE ubeeq_jobs_cell_scoped (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  correlation_id TEXT,
  last_error TEXT,
  cell_id TEXT NOT NULL,
  UNIQUE (cell_id, idempotency_key)
);
INSERT INTO ubeeq_jobs_cell_scoped (id,type,payload,idempotency_key,state,attempt,max_attempts,available_at,lease_token,lease_expires_at,created_at,updated_at,correlation_id,last_error,cell_id)
  SELECT id,type,payload,idempotency_key,state,attempt,max_attempts,available_at,lease_token,lease_expires_at,created_at,updated_at,correlation_id,last_error,cell_id FROM ubeeq_jobs;
DROP TABLE ubeeq_jobs;
ALTER TABLE ubeeq_jobs_cell_scoped RENAME TO ubeeq_jobs;
