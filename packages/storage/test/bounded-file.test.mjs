import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeBoundedStreamFile } from '../dist/index.js';

test('bounded file sink snapshots budgets, writes privately, hashes bytes and closes streams', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bounded-file-test-'));
  try {
    const path = join(directory, 'source'), body = Readable.from([Buffer.from('ab'), Buffer.from('cd')]);
    const limits = { maximumBytes: 4, contentLength: 4, expectedLength: 4 };
    const pending = writeBoundedStreamFile(body, path, limits);
    limits.maximumBytes = 1; limits.contentLength = 1; limits.expectedLength = 1;
    assert.deepEqual(await pending, { byteLength: 4, checksumSha256: createHash('sha256').update('abcd').digest('hex') });
    assert.equal(await readFile(path, 'utf8'), 'abcd'); assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal(body.destroyed, true);
    const duplicate = Readable.from([Buffer.from('new')]);
    await assert.rejects(writeBoundedStreamFile(duplicate, path, { maximumBytes: 4 }), { code: 'EEXIST' });
    assert.equal(duplicate.destroyed, true); assert.equal(await readFile(path, 'utf8'), 'abcd');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('sink rejects invalid limits, excess bytes, inconsistent lengths and stream failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bounded-file-test-'));
  let index = 0;
  try {
    for (const value of [0, -1, NaN, Infinity, 1.5]) for (const key of ['maximumBytes', 'contentLength', 'expectedLength']) {
      const body = Readable.from([Buffer.from('a')]), path = join(directory, String(index++));
      await assert.rejects(writeBoundedStreamFile(body, path, { maximumBytes: 4, [key]: value }));
      assert.equal(body.destroyed, true); await assert.rejects(stat(path), { code: 'ENOENT' });
    }
    for (const [bytes, limits] of [['abcde', { maximumBytes: 4 }], ['', { maximumBytes: 4 }], ['abc', { maximumBytes: 4, expectedLength: 4 }], ['abcd', { maximumBytes: 10, contentLength: 4, expectedLength: 3 }]]) {
      const body = Readable.from([Buffer.from(bytes)]);
      await assert.rejects(writeBoundedStreamFile(body, join(directory, String(index++)), limits)); assert.equal(body.destroyed, true);
    }
    const broken = Readable.from((async function* () { yield Buffer.from('a'); throw new Error('broken stream'); })());
    await assert.rejects(writeBoundedStreamFile(broken, join(directory, 'broken'), { maximumBytes: 4 }), /broken stream/);
    assert.equal(broken.destroyed, true);
    await assert.rejects(writeBoundedStreamFile(Readable.from([]), 'relative', { maximumBytes: 4 }), /absolute/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
