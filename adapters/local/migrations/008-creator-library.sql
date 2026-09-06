CREATE TABLE ubeeq_creator_library (
  cell_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (cell_id, tenant_id, kind, id)
);
CREATE INDEX ubeeq_creator_library_owner ON ubeeq_creator_library (cell_id, tenant_id, kind, creator_id);
