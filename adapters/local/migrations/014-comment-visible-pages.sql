CREATE INDEX IF NOT EXISTS ubeeq_comments_visible_target
  ON ubeeq_comments (cell_id, tenant_id, target_type, target_id, created_at, comment_id)
  WHERE json_extract(payload, '$.hidden') = 0;
