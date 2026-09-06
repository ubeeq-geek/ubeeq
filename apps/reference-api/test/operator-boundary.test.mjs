import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReferenceApi } from '../dist/server.js';
import { createLocalAdapterSet } from '@ubeeq/adapter-local';

test('every operations route requires configured operator authority before reads or writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ubeeq-operator-'));
  const local = createLocalAdapterSet({ databasePath: join(directory, 'state.sqlite'), dataDirectory: directory, publicBaseUrl: 'http://localhost', cellId: 'cell' });
  const identity = { verifySession: async ({ credential }) => ['creator', 'operator'].includes(credential)
    ? { id: credential, subject: { id: credential, roles: [credential], scopes: [] } } : undefined };
  const routes = [['GET', 'jobs'], ['POST', 'jobs/run-next'], ['POST', 'jobs/missing/recover'], ['POST', 'jobs/missing/cancel'],
    ['GET', 'holds'], ['POST', 'holds'], ['POST', 'holds/missing/release'], ['GET', 'review-cases'], ['POST', 'review-cases'],
    ['POST', 'review-cases/missing'], ['GET', 'moderation-evidence'], ['GET', 'audit-events'], ['GET', 'usage-events']];
  try {
    for (const requirement of [undefined, {}, { anyRoles: ['operator'] }]) {
      const api = createReferenceApi({ publicBaseUrl: 'http://127.0.0.1:0', cellId: 'cell', operatorAuthorization: requirement,
        adapters: { repositories: local.repositories, storage: local.storage, uploads: local.storage, delivery: local.storage, jobs: local.jobs, identity } });
      await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${api.server.address().port}`;
      try {
        for (const [method, path] of routes) {
          const response = await fetch(`${base}/v1/operations/${path}`, { method, headers: { authorization: 'Bearer creator', 'content-type': 'application/json', 'x-user-role': 'operator' }, ...(method === 'POST' ? { body: '{}' } : {}) });
          assert.equal(response.status, requirement?.anyRoles ? 403 : 404, path);
        }
        if (requirement?.anyRoles) {
          const cancelled = await local.jobs.enqueue({ cellId: 'cell', type: 'test', payload: {}, idempotencyKey: 'cancelled', maxAttempts: 1 });
          await local.jobs.cancel({ id: cancelled.id });
          const recovery = await fetch(`${base}/v1/operations/jobs/${cancelled.id}/recover`, { method: 'POST', headers: { authorization: 'Bearer operator', 'content-type': 'application/json' }, body: '{}' });
          assert.equal(recovery.status, 409);
          assert.equal((await recovery.json()).error.code, 'job_not_recoverable');
          assert.equal((await local.jobs.get(cancelled.id)).state, 'cancelled');
          assert.equal((await fetch(`${base}/v1/operations/holds`)).status, 401);
          const created = await fetch(`${base}/v1/operations/holds`, { method: 'POST', headers: { authorization: 'Bearer operator', 'content-type': 'application/json' }, body: JSON.stringify({ subjectType: 'work', subjectId: 'work' }) });
          assert.equal(created.status, 201);
          assert.equal((await fetch(`${base}/v1/operations/holds`, { headers: { authorization: 'Bearer operator' } })).status, 200);
        } else assert.equal((await local.repositories.moderationHolds.list({ limit: 10 })).items.length, 0);
      } finally { await api.close(); }
    }
  } finally { local.database.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
