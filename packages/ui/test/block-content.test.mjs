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

test('portable inline rendering drops active content, and destination heading limits are explicit', () => {
  assert.equal(textToInlineHtml('<img onerror="bad">\nnext'), '&lt;img onerror=&quot;bad&quot;&gt;<br>next');
  assert.equal(sanitizeInlineHtml('<script>bad</script>'), '');
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

test('HTML description import preserves headings, quotes, dividers and inline runs without browser globals', () => {
  const blocks = parseDescriptionBlocks('Before <b>bold</b><h3>Heading</h3><blockquote>Quoted <i>words</i></blockquote><hr><p>After &amp; next</p>');
  assert.deepEqual(blocks.map(block => block.type), ['paragraph', 'heading', 'quote', 'divider', 'paragraph']);
  assert.equal(blocks[0].html, 'Before <strong>bold</strong>');
  assert.equal(blocks[1].level, 3); assert.equal(blocks[1].text, 'Heading');
  assert.equal(blocks[2].quote, 'Quoted words'); assert.equal(blocks[2].html, 'Quoted <em>words</em>');
  assert.equal(blocks[4].text, 'After & next');
  assert.equal(new Set(blocks.map(block => block.blockId)).size, 5);
  assert.match(serializeDescriptionBlocks(blocks), /<h3>Heading<\/h3>/);
});

test('HTML description import drops active content and unsafe links while retaining safe metadata', () => {
  const blocks = parseDescriptionBlocks('<script>private-script</script><svg><text>foreign</text></svg><p onclick="bad()">Safe <a href="javascript:bad()">label</a> <a href="https://example.test/">link</a><img src="private-source" onerror="bad()"></p>');
  const html = serializeDescriptionBlocks(blocks);
  assert.doesNotMatch(html, /private-script|foreign|onclick|javascript:|private-source|onerror|<img/);
  assert.match(html, /Safe label/); assert.match(html, /href="https:\/\/example.test\/"/);
});

test('description input has one total budget rather than per-paragraph bypasses', () => {
  assert.throws(() => parseDescriptionBlocks('x'.repeat(1_048_577)), /input budget/);
  assert.throws(() => parseDescriptionBlocks('<p>x</p>'.repeat(150000)), /input budget/);
  assert.throws(() => parseDescriptionBlocks('<br>'.repeat(50001)), /structure budget/);
  assert.throws(() => parseDescriptionBlocks('<span>'.repeat(257) + 'text' + '</span>'.repeat(257)), /structure budget/);
});
