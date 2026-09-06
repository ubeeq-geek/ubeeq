import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatorProfileService } from '../dist/index.js';

test('profile updates allowlist fields, preserve identity and authorize before validation', async () => {
  let row = { id: 'creator', instanceId: 'tenant', revision: 1, displayName: 'Before', subjectId: 'owner' };
  let allowed = true;
  const service = new CreatorProfileService({ get: async () => row, commit: async (id, revision, fields) => {
    assert.equal(revision, row.revision); row = { ...row, ...fields, revision: revision + 1 }; return row;
  } }, async () => allowed);
  const result = await service.update('tenant', 'creator', 1, { displayName: ' After ', bio: ' bio ', links: [{ label: ' Site ', url: 'https://example.test' }], subjectId: 'attacker' });
  assert.equal(result.subjectId, 'owner'); assert.equal(result.displayName, 'After'); assert.equal(result.bio, 'bio');
  assert.deepEqual(result.links, [{ label: 'Site', url: 'https://example.test/' }]);
  await assert.rejects(service.update('tenant', 'creator', 1, { bio: 'stale' }), { code: 'revision_conflict' });
  for (const links of [[{ label: 'bad', url: 'javascript:alert(1)' }], [{ label: 'bad', url: 'https://user:pass@example.test' }], [null]]) {
    await assert.rejects(service.update('tenant', 'creator', 2, { links }), { code: 'invalid_profile' });
  }
  allowed = false;
  await assert.rejects(service.update('tenant', 'creator', 0, { displayName: '' }), { code: 'access_denied' });
  await assert.rejects(service.update('other', 'creator', 2, { bio: 'foreign' }), { code: 'not_found' });
  assert.equal(row.revision, 2);
});
