import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BlockEditor } from '../dist/react.js';

test('optional editor renders editing tools and supplied media without mutating source blocks', () => {
  const value = [{ blockId: 'image', type: 'image', mediaId: 'asset', caption: '<script>literal</script>', payload: { custom: { keep: true } } }];
  const before = structuredClone(value);
  const html = renderToStaticMarkup(createElement(BlockEditor, { value, onChange: () => assert.fail('Render must not commit edits'), allowMedia: true,
    mediaOptions: [{ mediaId: 'asset', label: 'Private original' }] }));
  assert.match(html, /Active block tools/);
  assert.match(html, /Add media block/);
  assert.match(html, /Private original/);
  assert.match(html, /&lt;script&gt;literal&lt;\/script&gt;/);
  assert.deepEqual(value, before);
});

test('read-only editor omits mutation tools and marks text and captions read-only', () => {
  const value = [{ blockId: 'text', type: 'paragraph', text: 'Content' }, { blockId: 'image', type: 'image', mediaId: 'asset' }];
  const html = renderToStaticMarkup(createElement(BlockEditor, { value, readOnly: true, onChange: () => assert.fail('Read-only render must not edit') }));
  assert.doesNotMatch(html, /Active block tools|Add content block|Remove block/);
  assert.match(html, /contenteditable="false"/);
  assert.match(html, /aria-readonly="true"/);
  assert.match(html, /readonly=""/);
});

test('framework-neutral entry point does not load React', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./dist/index.js'); if (Object.keys(require.cache).some(path => /node_modules[\\/]react[\\/]/.test(path))) process.exit(1)"],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('nested sections render shared editors and unsupported blocks remain visible as preserved content', () => {
  const value = [{ blockId: 'section', type: 'section', title: 'Nested section', blocks: [
    { blockId: 'text', type: 'paragraph', text: 'Nested text' }, { blockId: 'embed', type: 'embed', url: 'https://example.test' }
  ] }];
  const html = renderToStaticMarkup(createElement(BlockEditor, { value, readOnly: true, onChange: () => assert.fail('Render must not mutate') }));
  assert.match(html, /Nested section/);
  assert.match(html, /Preserved embed block/);
  assert.match(html, /aria-readonly="true"/);
  assert.doesNotMatch(html, /Active block tools/);
});

test('file blocks expose metadata controls without embedding active content or storage URLs', () => {
  const value = [{ blockId: 'file', type: 'file', mediaId: 'asset', label: '<script>label</script>',
    caption: 'A document', mimeType: 'text/html', html: '<script>execute()</script>', url: 'https://private-storage.test/original' }];
  const html = renderToStaticMarkup(createElement(BlockEditor, { value, readOnly: true, onChange: () => assert.fail('Render must not edit') }));
  assert.match(html, /File label/); assert.match(html, /Caption/);
  assert.match(html, /&lt;script&gt;label&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<iframe|<object|<embed|execute\(\)|private-storage/);
  assert.match(html, /readonly=""/);
});

test('structured insertion is opt-in and link/credit values remain inert metadata', () => {
  const value = [{ blockId: 'link', type: 'link', label: 'Reference', url: 'javascript:alert(1)' },
    { blockId: 'credit', type: 'credit', author: 'Author', text: '<script>literal</script>', url: 'https://example.test' }];
  const props = { value, onChange: () => assert.fail('Render must not edit') };
  const description = renderToStaticMarkup(createElement(BlockEditor, props));
  assert.doesNotMatch(description, />Section<|>Link block<|>Credit<\/button>/);
  const body = renderToStaticMarkup(createElement(BlockEditor, { ...props, allowStructured: true }));
  assert.match(body, />Section</); assert.match(body, />Link block</); assert.match(body, />Credit<\/button>/);
  assert.match(body, /Credit author/); assert.match(body, /Link URL/);
  assert.doesNotMatch(body, /href=|<script>/);
});

test('website sections are flat, individually removable and have closed properties initially', async () => {
  const {flattenWebsiteSections}=await import('../dist/block-content.js');
  const p=(id,text)=>({blockId:id,type:'paragraph',text});
  const value=[{blockId:'main',type:'section',title:'Main',payload:{presentation:'standard'},blocks:[p('before','Before'),{blockId:'mail',type:'section',title:'Mailing list',payload:{presentation:'callout'},blocks:[p('signup','Sign up')]},p('after','After')]}];
  const before=structuredClone(value),flat=flattenWebsiteSections(value);
  assert.deepEqual(flat.flatMap(section=>section.blocks.map(block=>block.text)),['Before','Sign up','After']);
  assert.equal(flat.length,3);assert.equal(flat[1].blockId,'mail');assert.equal(flat[1].payload.presentation,'callout');
  assert.ok(flat.every(section=>section.blocks.every(block=>block.type!=='section')));
  assert.deepEqual(flattenWebsiteSections(flat),flat);assert.deepEqual(value,before);
  const html=renderToStaticMarkup(createElement(BlockEditor,{value,websiteOptions:{pages:[],publications:[]},allowStructured:true,onChange:()=>assert.fail('Rendering must not save changes')}));
  assert.match(html,/Remove section Mailing list/);assert.match(html,/aria-expanded="false">More Actions/);
  assert.equal((html.match(/>Section<\/button>/g)||[]).length,1);
  assert.equal((html.match(/class="portable-section-heading"/g)||[]).length,3);
});
