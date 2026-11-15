CREATE TABLE IF NOT EXISTS ubeeq_repository_versions (
  repository TEXT PRIMARY KEY,
  version BIGINT NOT NULL CHECK (version >= 0)
);
CREATE OR REPLACE FUNCTION ubeeq_record_repository_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed_repository TEXT;
BEGIN
  changed_repository := CASE WHEN TG_OP = 'DELETE' THEN OLD.repository ELSE NEW.repository END;
  INSERT INTO ubeeq_repository_versions (repository, version) VALUES (changed_repository, 1)
  ON CONFLICT(repository) DO UPDATE SET version = ubeeq_repository_versions.version + 1;
  IF TG_OP = 'UPDATE' AND OLD.repository <> NEW.repository THEN
    INSERT INTO ubeeq_repository_versions (repository, version) VALUES (OLD.repository, 1)
    ON CONFLICT(repository) DO UPDATE SET version = ubeeq_repository_versions.version + 1;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER ubeeq_record_repository_change AFTER INSERT OR UPDATE OR DELETE ON ubeeq_records
FOR EACH ROW EXECUTE FUNCTION ubeeq_record_repository_change();
