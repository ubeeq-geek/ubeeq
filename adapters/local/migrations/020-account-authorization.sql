-- Existing password accounts retain their established creator authority.
-- Subsequent authorization reads use these current values, not session defaults.
ALTER TABLE ubeeq_accounts ADD COLUMN account_scope TEXT NOT NULL DEFAULT 'creator_operator';
ALTER TABLE ubeeq_accounts ADD COLUMN roles_json TEXT NOT NULL DEFAULT '["creator"]';
ALTER TABLE ubeeq_accounts ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '["creator.read","creator.write","work.publish","export.create"]';
