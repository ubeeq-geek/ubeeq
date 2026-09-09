CREATE INDEX IF NOT EXISTS ubeeq_creator_asset_checksum
  ON ubeeq_creator_library (cell_id, tenant_id, creator_id, json_extract(payload, '$.checksumSha256'), id)
  WHERE kind = 'asset';

-- Derived reverse membership index; the existing JSON record remains canonical.
CREATE TABLE IF NOT EXISTS ubeeq_creator_asset_memberships (
  cell_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
  work_id TEXT NOT NULL, asset_id TEXT NOT NULL,
  PRIMARY KEY (cell_id, tenant_id, work_id, asset_id)
);
CREATE INDEX IF NOT EXISTS ubeeq_creator_asset_membership_source
  ON ubeeq_creator_asset_memberships (cell_id, tenant_id, asset_id, work_id);

CREATE TRIGGER IF NOT EXISTS ubeeq_creator_asset_membership_insert
AFTER INSERT ON ubeeq_creator_library WHEN NEW.kind = 'work_assets'
BEGIN
  DELETE FROM ubeeq_creator_asset_memberships WHERE cell_id = NEW.cell_id AND tenant_id = NEW.tenant_id AND work_id = NEW.id;
  INSERT OR IGNORE INTO ubeeq_creator_asset_memberships
    SELECT NEW.cell_id, NEW.tenant_id, NEW.id, json_extract(value, '$.assetId')
    FROM json_each(NEW.payload)
    WHERE json_type(value, '$.assetId') = 'text' AND json_extract(value, '$.workId') = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ubeeq_creator_asset_membership_update
AFTER UPDATE ON ubeeq_creator_library WHEN OLD.kind = 'work_assets' OR NEW.kind = 'work_assets'
BEGIN
  DELETE FROM ubeeq_creator_asset_memberships WHERE cell_id = OLD.cell_id AND tenant_id = OLD.tenant_id AND work_id = OLD.id;
  INSERT OR IGNORE INTO ubeeq_creator_asset_memberships
    SELECT NEW.cell_id, NEW.tenant_id, NEW.id, json_extract(value, '$.assetId')
    FROM json_each(NEW.payload)
    WHERE NEW.kind = 'work_assets' AND json_type(value, '$.assetId') = 'text' AND json_extract(value, '$.workId') = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ubeeq_creator_asset_membership_delete
AFTER DELETE ON ubeeq_creator_library WHEN OLD.kind = 'work_assets'
BEGIN
  DELETE FROM ubeeq_creator_asset_memberships WHERE cell_id = OLD.cell_id AND tenant_id = OLD.tenant_id AND work_id = OLD.id;
END;

INSERT OR IGNORE INTO ubeeq_creator_asset_memberships
  SELECT library.cell_id, library.tenant_id, library.id, json_extract(member.value, '$.assetId')
  FROM ubeeq_creator_library AS library, json_each(library.payload) AS member
  WHERE library.kind = 'work_assets' AND json_type(member.value, '$.assetId') = 'text'
    AND json_extract(member.value, '$.workId') = library.id;
