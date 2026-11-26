import test from 'node:test';
import assert from 'node:assert/strict';
import { announcementTemplateBlocks, announcementTemplateCustomization, announcementTemplatePresentation, announcementLayoutPreset, announcementLinkSourceKey, renderAnnouncementTemplate, validateAnnouncementTemplate } from '../dist/index.js';

const values = { 'collection.title': 'Summer Vibes', 'creator.name': 'A Creator', 'release.kind': 'additions', 'primaryLink.url': 'https://example.test/preview', 'primaryLink.label': 'Read' };
const group = (links) => ({ id: 'previews', type: 'paragraph', linkGroup: { heading: 'Preview:', links } });
const link = (id, destinationKey, extra = {}) => ({ id, label: id, source: { kind: 'publication', destinationKey }, ...extra });
test('link groups preserve order, use their own counts, and expand into existing blocks', () => {
  const a = link('Free', 'free', { showCount: true }), b = link('Full', 'full', { showCount: true, countUnit: 'photos' });
  const template = { blocks: [group([a, b])] };
  const blocks = renderAnnouncementTemplate({ template, values, links: {
    [announcementLinkSourceKey(a.source)]: { url: 'https://example.test/free', publishedWorkCount: 5 },
    [announcementLinkSourceKey(b.source)]: { url: 'https://example.test/full', publishedWorkCount: 50 }
  } });
  assert.deepEqual(blocks.map(b => b.text ?? b.label), ['Preview:', 'Free (5)', 'Full (50 photos)']);
  assert.equal(blocks[1].groupId, blocks[2].groupId);
  assert.deepEqual(template.blocks[0].linkGroup.links, [a, b]);
});
test('required links and counts wait, optional missing links omit empty sections, and custom URLs have no counts', () => {
  assert.throws(() => renderAnnouncementTemplate({ template: { blocks: [group([link('one', 'missing')])] }, values }), /Wait for the published link/);
  assert.deepEqual(renderAnnouncementTemplate({ template: { blocks: [group([link('one', 'missing', { required: false })])] }, values }), []);
  const counted = link('one', 'target', { showCount: true });
  assert.throws(() => renderAnnouncementTemplate({ template: { blocks: [group([counted])] }, values, links: { [announcementLinkSourceKey(counted.source)]: { url: 'https://example.test/a' } } }), /Confirm the published count/);
  assert.throws(() => validateAnnouncementTemplate({ blocks: [group([{ id: 'one', label: 'Custom', source: { kind: 'url', url: 'https://example.test/a' }, showCount: true }])] }), /Custom URLs/);
  assert.throws(() => validateAnnouncementTemplate({ blocks: [group([{ id: 'one', label: 'Custom', source: { kind: 'url', url: 'https://example.test/a?token=secret' } }])] }));
});
test('unchanged sections inherit later shared edits and new destinations inherit platform settings', () => {
  const base = [{ id: 'heading', type: 'heading', text: 'Original' }, { id: 'body', type: 'paragraph', text: 'Shared' }];
  const patch = announcementTemplateCustomization(base, [base[0], { ...base[1], text: 'Discord copy' }]);
  const template = { blocks: [{ ...base[0], text: 'Updated shared heading' }, base[1]], platformCustomizations: { discord: { ...patch, presentation: { discord: 'message' } } } };
  assert.deepEqual(announcementTemplateBlocks(template, 'discord', 'new-destination').map(b => b.text), ['Updated shared heading', 'Discord copy']);
  assert.equal(announcementTemplatePresentation(template, 'discord', 'new-destination').discord, 'message');
  assert.equal(announcementTemplateBlocks({ ...template, destinationOverrides: { old: [{ id: 'old', type: 'paragraph', text: 'Legacy' }] } }, 'discord', 'old')[0].text, 'Legacy');
});
test('series and event labels remain separate from creator and platform names', () => {
  const template = announcementLayoutPreset('update');
  template.fields.seriesName = 'A series';
  const output = renderAnnouncementTemplate({ template, values });
  assert.equal(output[0].text, 'UPDATE: A series');
  assert.equal(output[1].text, 'Summer Vibes');
  assert.equal(renderAnnouncementTemplate({ template: { ...template, fields: undefined }, values })[0].text, 'UPDATE: A Creator');
});
test('related collections with the same platform target retain distinct source identities', () => {
  assert.notEqual(announcementLinkSourceKey({ kind: 'publication', destinationKey: 'native' }), announcementLinkSourceKey({ kind: 'publication', destinationKey: 'native', collectionId: 'related' }));
});


test('expanded groups allocate deterministic IDs without colliding with headings or authored nested blocks', () => {
 const url={kind:'url',url:'https://example.test/gallery'};
 const template={blocks:[
  group([{id:'heading',label:'Gallery',source:url},{id:'heading-2',label:'Second',source:url}]),
  {id:'wrapper',type:'paragraph',children:[{id:'previews-heading',type:'paragraph',text:'Authored block'},{id:'previews-heading-2',type:'paragraph',text:'Another authored block'}]},
  {id:'previews-heading-3',type:'paragraph',linkGroup:{heading:'Other group',links:[{id:'heading',label:'Another gallery',source:url}]}}
 ]};
 validateAnnouncementTemplate(template);
 const output=renderAnnouncementTemplate({template,values});
 const ids=[];const collect=blocks=>{for(const block of blocks){ids.push(block.id);if(block.children)collect(block.children);}};collect(output);
 assert.equal(new Set(ids).size,ids.length);
 assert.equal(output.find(block=>block.id==='wrapper').children[0].id,'previews-heading');
 assert.deepEqual(renderAnnouncementTemplate({template,values}),output);
 assert.deepEqual(output.filter(block=>block.type==='link').map(block=>block.label),['Gallery','Second','Another gallery']);
});
