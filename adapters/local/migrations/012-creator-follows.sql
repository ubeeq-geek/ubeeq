CREATE TABLE IF NOT EXISTS ubeeq_creator_follows (
  cell_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (cell_id, tenant_id, user_id, creator_id)
);
