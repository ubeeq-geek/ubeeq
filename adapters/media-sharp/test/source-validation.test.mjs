import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { validateImageSource } from '../dist/index.js';

test('source validation decodes supported formats and checks the declared MIME', async () => {
  for (const format of ['jpeg', 'png', 'webp', 'gif', 'tiff']) {
    const bytes = await sharp({ create: { width: 16, height: 8, channels: 3, background: '#8844aa' } }).toFormat(format).toBuffer();
    assert.deepEqual(await validateImageSource(bytes, `image/${format}`), { safe: true, decodedFormat: format });
    assert.deepEqual(await validateImageSource(bytes, format === 'png' ? 'image/jpeg' : 'image/png'), { safe: false, reason: 'mime_mismatch' });
    assert.deepEqual(await validateImageSource(bytes, `image/${format}`, { maxInputPixels: 64 }), { safe: false, reason: 'invalid_image' });
    assert.deepEqual(await validateImageSource(bytes, `image/${format}`, { maxInputBytes: bytes.length - 1 }), { safe: false, reason: 'invalid_source_size' });
  }
});

test('source validation fails closed without decoder diagnostics and rejects invalid budgets', async () => {
  assert.deepEqual(await validateImageSource(new Uint8Array(), 'image/png'), { safe: false, reason: 'invalid_source_size' });
  assert.deepEqual(await validateImageSource(Buffer.from('private malformed input'), 'image/png'), { safe: false, reason: 'invalid_image' });
  assert.deepEqual(await validateImageSource(Buffer.from('<svg/>'), 'image/svg+xml'), { safe: false, reason: 'unsupported_mime' });
  for (const budget of [0, -1, Infinity, 0.5]) {
    await assert.rejects(validateImageSource(new Uint8Array(), 'image/png', { maxInputBytes: budget }), /positive integers/);
    await assert.rejects(validateImageSource(new Uint8Array(), 'image/png', { maxInputPixels: budget }), /positive integers/);
  }
});
