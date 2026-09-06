CREATE TABLE IF NOT EXISTS ubeeq_creator_handle_aliases (
  instance_id TEXT NOT NULL, handle TEXT NOT NULL, creator_id TEXT NOT NULL,
  PRIMARY KEY (instance_id, handle)
);
CREATE INDEX IF NOT EXISTS ubeeq_creator_handle_alias_owner ON ubeeq_creator_handle_aliases (creator_id);
-- Backfill current and imported historical aliases. Collisions fail, never reassign.
INSERT INTO ubeeq_creator_handle_aliases (instance_id, handle, creator_id)
SELECT DISTINCT json_extract(records.payload, '$.instanceId'), handles.value, records.id
FROM ubeeq_records AS records, json_each(
  json_insert(COALESCE(json_extract(records.payload, '$.handleHistory'), '[]'), '$[#]', json_extract(records.payload, '$.handle'))
) AS handles
WHERE records.repository = 'creators' AND handles.value IS NOT NULL
  AND json_extract(records.payload, '$.instanceId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM ubeeq_creator_handle_aliases AS existing
    WHERE existing.instance_id = json_extract(records.payload, '$.instanceId')
      AND existing.handle = handles.value AND existing.creator_id = records.id);
CREATE TRIGGER IF NOT EXISTS ubeeq_creator_handle_insert AFTER INSERT ON ubeeq_records
WHEN NEW.repository = 'creators'
BEGIN
  INSERT INTO ubeeq_creator_handle_aliases (instance_id, handle, creator_id)
  SELECT json_extract(NEW.payload, '$.instanceId'), value, NEW.id
  FROM (
    SELECT json_extract(NEW.payload, '$.handle') AS value
    UNION SELECT value FROM json_each(NEW.payload, '$.handleHistory')
  ) AS handles
  WHERE value IS NOT NULL AND json_extract(NEW.payload, '$.instanceId') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM ubeeq_creator_handle_aliases AS existing
      WHERE existing.instance_id = json_extract(NEW.payload, '$.instanceId')
        AND existing.handle = handles.value AND existing.creator_id = NEW.id
    );
END;
CREATE TRIGGER IF NOT EXISTS ubeeq_creator_handle_update AFTER UPDATE ON ubeeq_records
WHEN NEW.repository = 'creators'
BEGIN
  INSERT INTO ubeeq_creator_handle_aliases (instance_id, handle, creator_id)
  SELECT json_extract(NEW.payload, '$.instanceId'), value, NEW.id
  FROM (
    SELECT json_extract(NEW.payload, '$.handle') AS value
    UNION SELECT value FROM json_each(NEW.payload, '$.handleHistory')
  ) AS handles
  WHERE value IS NOT NULL AND json_extract(NEW.payload, '$.instanceId') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM ubeeq_creator_handle_aliases AS existing
      WHERE existing.instance_id = json_extract(NEW.payload, '$.instanceId')
        AND existing.handle = handles.value AND existing.creator_id = NEW.id
    );
END;
CREATE TRIGGER IF NOT EXISTS ubeeq_creator_handle_delete AFTER DELETE ON ubeeq_records
WHEN OLD.repository = 'creators'
BEGIN
  DELETE FROM ubeeq_creator_handle_aliases WHERE creator_id = OLD.id;
END;
