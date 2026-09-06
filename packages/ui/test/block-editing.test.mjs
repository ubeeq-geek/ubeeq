import test from 'node:test';
import assert from 'node:assert/strict';
import { changeTextBlockType, movePostBlock, createStructuredBlock } from '../dist/index.js';

test('text type changes retain identity, nested blocks and extension metadata', () => {
  const source = { blockId: 'quote', type: 'quote', quote: 'Quoted text', text: 'Quoted text', author: 'Author',
    payload: { custom: { flags: [1] } }, blocks: [{ blockId: 'child', type: 'file', fileId: 'original', mediaId: 'asset' }] };
  const heading = changeTextBlockType(source, 'heading');
  assert.equal(heading.blockId, source.blockId); assert.equal(heading.level, 2);
  assert.equal(heading.text, 'Quoted text'); assert.equal(heading.quote, undefined);
  assert.equal(heading.author, 'Author'); assert.deepEqual(heading.blocks, source.blocks);
  heading.payload.custom.flags.push(2); heading.blocks[0].fileId = 'changed';
  assert.deepEqual(source.payload.custom.flags, [1]); assert.equal(source.blocks[0].fileId, 'original');
  const paragraph = changeTextBlockType(heading, 'paragraph');
  assert.equal(paragraph.level, undefined); assert.equal(paragraph.quote, undefined);
  const quote = changeTextBlockType(paragraph, 'quote');
  assert.equal(quote.quote, paragraph.text);
  assert.throws(() => changeTextBlockType({ blockId: 'image', type: 'image', mediaId: 'asset' }, 'paragraph'), /Only text/);
});

test('moving a block preserves its complete subtree and does not mutate the input', () => {
  const blocks = [{ blockId: 'section', type: 'section', payload: { key: ['value'] }, blocks: [{ blockId: 'child', type: 'image', mediaId: 'asset' }] },
    { blockId: 'paragraph', type: 'paragraph', text: 'Next' }];
  const moved = movePostBlock(blocks, 'section', 1);
  assert.deepEqual(moved.map(block => block.blockId), ['paragraph', 'section']);
  assert.deepEqual(moved[1], blocks[0]);
  moved[1].payload.key.push('changed');
  assert.deepEqual(blocks[0].payload.key, ['value']);
  assert.deepEqual(movePostBlock(blocks, 'section', -1), blocks);
  assert.throws(() => movePostBlock(blocks, 'missing', 1), /Invalid block/);
});

test('structured block creation supplies distinct identities and preserves empty section semantics', () => {
  const section = createStructuredBlock('section'), link = createStructuredBlock('link'), credit = createStructuredBlock('credit');
  assert.equal(new Set([section.blockId, link.blockId, credit.blockId]).size, 3);
  assert.deepEqual(section.blocks, []); assert.equal(section.title, '');
  assert.equal(link.url, ''); assert.equal(link.label, '');
  assert.equal(credit.author, ''); assert.equal(credit.text, '');
  assert.throws(() => createStructuredBlock('unsupported'), /Unsupported/);
});
