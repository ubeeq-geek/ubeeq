import test from 'node:test';
import assert from 'node:assert/strict';
import { startPeriodicWorkers } from '../dist/index.js';

test('periodic workers do not overlap and shutdown drains accepted work', async () => {
  let begin, release, calls = 0, stopped = false;
  const entered = new Promise(resolve => { begin = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const workers = startPeriodicWorkers([{ intervalMs: 5, run: async () => { calls++; begin(); await blocked; }, onError: () => assert.fail('unexpected failure') }]);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await entered;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    const stopping = workers.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(stopped, false);
    release(); await stopping;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    await workers.stop();
  } finally { release(); await workers.stop(); clearTimeout(keepAlive); }
});
