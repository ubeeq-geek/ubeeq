-- Canonical current handles are unique within an instance in this database.
-- Existing duplicates deliberately fail migration; never rename user identities.
CREATE UNIQUE INDEX IF NOT EXISTS ubeeq_creator_current_handle
ON ubeeq_records (json_extract(payload, '$.instanceId'), json_extract(payload, '$.handle'))
WHERE repository = 'creators';
