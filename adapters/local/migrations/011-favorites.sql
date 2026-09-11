CREATE TABLE IF NOT EXISTS ubeeq_favorites (
  cell_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  profile_type TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (cell_id, tenant_id, profile_type, profile_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS ubeeq_favorites_target
  ON ubeeq_favorites (cell_id, tenant_id, target_type, target_id);
