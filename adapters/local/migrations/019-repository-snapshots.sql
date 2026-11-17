CREATE TABLE IF NOT EXISTS ubeeq_repository_versions (
  repository TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0)
);
CREATE TRIGGER IF NOT EXISTS ubeeq_repository_insert_version AFTER INSERT ON ubeeq_records BEGIN
  INSERT INTO ubeeq_repository_versions (repository, version) VALUES (NEW.repository, 1)
  ON CONFLICT(repository) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS ubeeq_repository_update_version AFTER UPDATE ON ubeeq_records BEGIN
  INSERT INTO ubeeq_repository_versions (repository, version) VALUES (NEW.repository, 1)
  ON CONFLICT(repository) DO UPDATE SET version = version + 1;
  INSERT INTO ubeeq_repository_versions (repository, version) SELECT OLD.repository, 1 WHERE OLD.repository <> NEW.repository
  ON CONFLICT(repository) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS ubeeq_repository_delete_version AFTER DELETE ON ubeeq_records BEGIN
  INSERT INTO ubeeq_repository_versions (repository, version) VALUES (OLD.repository, 1)
  ON CONFLICT(repository) DO UPDATE SET version = version + 1;
END;
