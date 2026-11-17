-- Temporary custody is not another completion or quota authority. A single
-- provider session has either its legacy body or one accepted file, never both.
CREATE TABLE ubeeq_upload_stream_custody (
 id TEXT PRIMARY KEY REFERENCES ubeeq_uploads(id),
 lease_id TEXT NOT NULL,
 lease_expires_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('receiving','accepted')),
 byte_length INTEGER,
 checksum TEXT,
 CHECK((state='receiving' AND byte_length IS NULL AND checksum IS NULL) OR
       (state='accepted' AND byte_length>=0 AND length(checksum)=64))
);
