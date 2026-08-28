ALTER TABLE ubeeq_credentials ADD COLUMN cell_id TEXT;
ALTER TABLE ubeeq_uploads ADD COLUMN cell_id TEXT;
ALTER TABLE ubeeq_uploads ADD COLUMN creator_id TEXT;
ALTER TABLE ubeeq_uploads ADD COLUMN expires_at TEXT;
ALTER TABLE ubeeq_uploads ADD COLUMN expected_checksum TEXT;
ALTER TABLE ubeeq_uploads ADD COLUMN expected_byte_length INTEGER;
ALTER TABLE ubeeq_uploads ADD COLUMN operation TEXT;
