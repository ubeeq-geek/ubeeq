CREATE INDEX ubeeq_source_file_page
  ON ubeeq_creator_library (cell_id, tenant_id, creator_id, id)
  WHERE kind = 'source_file';
