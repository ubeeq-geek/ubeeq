CREATE INDEX IF NOT EXISTS ubeeq_export_publication_intents
  ON ubeeq_records (json_extract(payload, '$.homeCellId'), json_extract(payload, '$.instanceId'), json_extract(payload, '$.workId'), id)
  WHERE repository = 'publicationIntents';
CREATE INDEX IF NOT EXISTS ubeeq_export_integration_accounts
  ON ubeeq_records (json_extract(payload, '$.homeCellId'), json_extract(payload, '$.instanceId'), json_extract(payload, '$.creatorId'), id)
  WHERE repository = 'integrationAccounts';
CREATE INDEX IF NOT EXISTS ubeeq_export_work_publications
  ON ubeeq_records (json_extract(payload, '$.homeCellId'), json_extract(payload, '$.instanceId'), json_extract(payload, '$.workId'), id)
  WHERE repository = 'publications';
