import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { transferVerifiedObject } from '../dist/index.js';

const fixture = () => {
  const bytes = new TextEncoder().encode('original private bytes');
  const source = { bucket: 'source', key: 'cells/one/creators/owner/assets/original', versionId: 'source-version',
    contentType: 'image/png', byteLength: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex'), scope: 'private' };
  const input = { source, sourcePrefix: 'cells/one/creators/owner', destinationBucket: 'destination', destinationPrefix: 'cells/two/creators/target/assets' };
  const objects = new Map(), calls = [];
  const ports = {
    source: { get: async () => { calls.push('read-source'); return { object: { ...source }, body: bytes }; } },
    destination: { get: async reference => { calls.push('read-destination'); return objects.get(reference.key); } },
    writeDestination: async ({ object, body }) => { calls.push('write'); const stored = { ...object, versionId: 'provider-generated-version' };
      objects.set(stored.key, { object: stored, body: Uint8Array.from(body) }); return stored; },
    admit: async () => { calls.push('admit'); }
  };
  return { bytes, input, objects, calls, ports };
};
test('transfer verifies both byte streams and returns only an actual private destination reference', async () => {
  const { input, ports, calls, objects } = fixture();
  const before = structuredClone(input);
  const result = await transferVerifiedObject(ports, input);
  assert.deepEqual(calls, ['admit', 'read-source', 'admit', 'write', 'read-destination', 'admit']);
  assert.equal(result.versionId, 'provider-generated-version');
  assert.equal(result.scope, 'private');
  assert.match(result.key, /^cells\/two\/creators\/target\/assets\/[0-9a-f-]{36}$/);
  assert.equal(result.checksum, input.source.checksum);
  assert.deepEqual(input, before);
  const second = await transferVerifiedObject(ports, input);
  assert.notEqual(second.key, result.key); assert.equal(objects.size, 2);
});
test('scope, budget, source corruption and policy denial prevent destination writes', async () => {
  for (const change of [{ maxBytes: 1 }, { sourcePrefix: 'cells/one/creators/other' }, { destinationPrefix: '../target' }]) {
    const { ports, input, calls } = fixture(); await assert.rejects(transferVerifiedObject(ports, { ...input, ...change })); assert.deepEqual(calls, []);
  }
  for (const mode of ['deny-read', 'deny-write', 'corrupt', 'wrong-version']) {
    const { ports, input, calls, bytes } = fixture(); let admission = 0;
    ports.admit = async () => { if (++admission === (mode === 'deny-read' ? 1 : mode === 'deny-write' ? 2 : -1)) throw new Error('denied'); };
    if (mode === 'corrupt') bytes[0] ^= 1;
    if (mode === 'wrong-version') ports.source.get = async () => ({ object: { ...input.source, versionId: 'wrong' }, body: bytes });
    await assert.rejects(transferVerifiedObject(ports, input)); assert.equal(calls.includes('write'), false);
  }
});
test('destination corruption, wrong scope and late policy denial return no receipt and preserve uncertain output', async () => {
  for (const mode of ['corrupt', 'public', 'late-denial', 'ambiguous-write']) {
    const { ports, input, objects } = fixture(); const write = ports.writeDestination; let admissions = 0;
    ports.admit = async () => { if (++admissions === 3 && mode === 'late-denial') throw new Error('denied'); };
    ports.writeDestination = async args => {
      const object = await write(args);
      if (mode === 'corrupt') objects.get(object.key).body[0] ^= 1;
      if (mode === 'public') object.scope = 'public';
      if (mode === 'ambiguous-write') throw new Error('reply lost');
      return object;
    };
    await assert.rejects(transferVerifiedObject(ports, input));
    assert.equal(objects.size, 1);
  }
});

test('read adapters cannot mutate the references used for verification', async () => {
  for (const side of ['source', 'destination']) {
    const { ports, input, calls, bytes, objects } = fixture();
    ports[side].get = async reference => {
      reference.versionId = 'unexpected-version';
      return { object: { ...reference }, body: side === 'source' ? bytes : objects.get(reference.key).body };
    };
    await assert.rejects(transferVerifiedObject(ports, input), /verification/);
    assert.equal(input.source.versionId, 'source-version');
    if (side === 'source') assert.equal(calls.includes('write'), false);
  }
});
