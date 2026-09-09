CREATE INDEX IF NOT EXISTS ubeeq_work_publications
  ON ubeeq_records (json_extract(payload, '$.homeCellId'), json_extract(payload, '$.instanceId'),
    json_extract(payload, '$.workId'), json_extract(payload, '$.destination'), id)
  WHERE repository = 'publications';
