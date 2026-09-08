CREATE TABLE IF NOT EXISTS ubeeq_comments (
  cell_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (cell_id, tenant_id, comment_id)
);
CREATE INDEX IF NOT EXISTS ubeeq_comments_target
  ON ubeeq_comments (cell_id, tenant_id, target_type, target_id, created_at, comment_id);
