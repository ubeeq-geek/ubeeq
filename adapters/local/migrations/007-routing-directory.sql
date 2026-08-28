-- The managed routing directory is a control-plane data set.  It intentionally
-- stores only public cell endpoints and migration bookkeeping, never cell data.
CREATE TABLE IF NOT EXISTS ubeeq_cell_routes (
  creator_id TEXT PRIMARY KEY,
  home_cell_id TEXT NOT NULL,
  home_region TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  routing_revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ubeeq_migration_checkpoints (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ubeeq_migration_checkpoints_creator_id ON ubeeq_migration_checkpoints (creator_id, id);
