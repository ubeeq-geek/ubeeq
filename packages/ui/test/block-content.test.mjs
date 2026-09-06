import test from 'node:test';
import assert from 'node:assert/strict';
import { createDescriptionBlock, parseDescriptionBlocks, normalizeDescriptionBlocks, clonePostBlocks, textToInlineHtml, sanitizeInlineHtml, serializeDescriptionBlocks } from '../dist/index.js';

test('description import preserves text paragraphs and emits stable block identities', () => {
  const blocks = parseDescriptionBlocks('First < literal\nline\n\nSecond');
  assert.equal(blocks.length, 2);
  assert.notEqual(blocks[0].blockId, blocks[1].blockId);
  assert.equal(blocks[0].text, 'First < literal\nline');
  assert.equal(blocks[0].html, 'First &lt; literal<br>line');
  assert.equal(createDescriptionBlock('heading').level, 2);
  assert.equal(createDescriptionBlock('divider').text, undefined);
});

test('non-DOM fallback escapes HTML, and destination heading limits are explicit', () => {
  assert.equal(textToInlineHtml('<img onerror="bad">\nnext'), '&lt;img onerror=&quot;bad&quot;&gt;<br>next');
  assert.equal(sanitizeInlineHtml('<script>bad</script>'), '&lt;script&gt;bad&lt;/script&gt;');
  const heading = [{ blockId: 'heading', type: 'heading', level: 6, text: 'Heading' }];
  assert.equal(serializeDescriptionBlocks(heading), '<h6>Heading</h6>');
  assert.equal(serializeDescriptionBlocks(heading, { maxHeadingLevel: 3 }), '<h3>Heading</h3>');
  assert.deepEqual(normalizeDescriptionBlocks([{ blockId: 'media', type: 'image', mediaId: 'asset' }]), []);
});

test('block cloning preserves nested identity, media and unknown metadata without aliasing', () => {
  const source = [{ blockId: 'section', type: 'section', payload: { custom: { items: ['original'] } },
    blocks: [{ blockId: 'file', type: 'file', fileId: 'source-file', mediaId: 'asset', payload: { nested: { value: 1 } } }] }];
  const copy = clonePostBlocks(source);
  assert.deepEqual(copy, source);
  copy[0].payload.custom.items.push('changed'); copy[0].blocks[0].payload.nested.value = 2;
  assert.deepEqual(source[0].payload.custom.items, ['original']);
  assert.equal(source[0].blocks[0].payload.nested.value, 1);
});
