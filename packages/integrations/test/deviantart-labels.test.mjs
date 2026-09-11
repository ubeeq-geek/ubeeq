import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeviantArtPublicAiLabels as parse } from '../dist/index.js';
const url = 'https://www.deviantart.com/creator/art/title-123';
test('provider labels come only from the complete exact target record', () => {
  const target = '{"deviationId":123,"title":"A } brace","isAiGenerated":true,"isAiUseDisallowed":false}';
  for (const html of [target, target.replace(/"/g, '\\"')]) assert.deepEqual(parse(html, url), { isAiGenerated: true, noAi: false });
  assert.deepEqual(parse('{"deviationId":123}{"deviationId":124,"isAiGenerated":true}', url), {});
  assert.deepEqual(parse('{"deviationId":1234,"isAiGenerated":true}', url), {});
  assert.deepEqual(parse('{"deviationId":123,"nested":{"isAiGenerated":true}}', url), {});
  assert.deepEqual(parse('{"deviationId":123,"isAiGenerated":"false"}', url), {});
});
test('malformed, oversized, conflicting and off-provider label sources remain unknown', () => {
  for (const html of ['{"deviationId":123,"isAiGenerated":true', '{"deviationId":123,"title":"' + 'x'.repeat(5000) + '","isAiGenerated":true}',
    '{"deviationId":123,"isAiGenerated":true}{"deviationId":123,"isAiGenerated":false}']) assert.deepEqual(parse(html, url), {});
  const html = '{"deviationId":123,"isAiGenerated":true}';
  for (const invalid of ['invalid', 'http://deviantart.com/art/a-123', 'https://deviantart.com.example.test/art/a-123', 'https://example.test/art/a-123']) assert.deepEqual(parse(html, invalid), {});
});
