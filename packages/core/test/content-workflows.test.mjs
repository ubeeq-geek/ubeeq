import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferContentArrangement, defaultContentPreparation, contentWorkflowBlockers, validatePreviewRecipe,
  suggestContentPairs, captureContentPreset, resolveContentPreset } from '../dist/index.js';
const object=(id,role='original')=>({id,operationId:id,filename:`${id}.png`,media:'image',role,state:'ready',targets:[],provenance:'uploaded_original'});
test('inference counts originals and preserves every explicit entry context',()=>{
  const objects=[object('one'),object('two'),object('preview','preview'),object('cover','cover')];
  assert.deepEqual(inferContentArrangement({intent:'new'},objects),{arrangement:'collection',primaryCount:2,needsChoice:true});
  assert.equal(inferContentArrangement({intent:'work'},objects).arrangement,'work');
  assert.equal(inferContentArrangement({intent:'collection'},[objects[0]]).arrangement,'collection');
  assert.deepEqual(inferContentArrangement({intent:'add',target:{kind:'work',id:'existing',revision:4}},objects),{arrangement:'work',primaryCount:2,needsChoice:false});
  assert.deepEqual(inferContentArrangement({intent:'new'},[objects[0],objects[2],objects[3]]),{arrangement:'work',primaryCount:1,needsChoice:false});
});
test('unmatched previews stay visible and never become original members through inference',()=>{
  const original=object('one'),preview=object('one-preview','preview');
  assert.deepEqual(suggestContentPairs([original,preview]),[{objectId:'one-preview',candidateIds:['one']}]);
  const draft={title:'One',entry:{intent:'new'},objects:[original,preview],settings:defaultContentPreparation(),arrangementConfirmed:true};
  assert.equal(contentWorkflowBlockers(draft)[0].code,'ambiguous_file_roles');
  preview.targets=['one'];assert.deepEqual(contentWorkflowBlockers(draft),[]);
});
test('preview recipes reject invalid ranges and leave uploaded preparation non-regenerable',()=>{
  assert.throws(()=>validatePreviewRecipe({kind:'text',start:20,end:10}));
  assert.throws(()=>validatePreviewRecipe({kind:'time_range',startMs:0,endMs:0}));
  assert.throws(()=>validatePreviewRecipe({kind:'uploaded_prepared',regenerable:true}));
  assert.throws(()=>validatePreviewRecipe({kind:'shell',command:'anything'}));
  validatePreviewRecipe({kind:'uploaded_prepared',regenerable:false});
  validatePreviewRecipe({kind:'time_range',startMs:12000,endMs:30000});
});
test('presets strip content-specific outer settings and resolve exact creator/arrangement matches',()=>{
  const settings={...defaultContentPreparation(),assetId:'secret-original',signedUrl:'https://private.example/token',scheduledAt:'2026-01-01',announce:{...defaultContentPreparation().announce,authorization:'old-approval'}};
  const preset=captureContentPreset({id:'preset',creatorId:'creator',name:'Images',revision:1,applicability:{arrangement:'work',media:'image'},settings,isDefault:true});
  assert.equal(JSON.stringify(preset).includes('secret-original'),false);
  assert.equal(JSON.stringify(preset).includes('old-approval'),false);
  assert.equal(resolveContentPreset([preset],'creator','collection','image'),undefined);
  assert.equal(resolveContentPreset([preset],'other','work','image'),undefined);
  const applied=resolveContentPreset([preset],'creator','work','image');applied.settings.preview='generated';
  assert.equal(preset.settings.preview,'none');
  assert.throws(()=>resolveContentPreset([preset,{...preset,id:'another'}],'creator','work','image'),/Several/);
});
test('preset templates cannot retain concrete private media, signed links or unrelated subject bindings',()=>{
 const settings=defaultContentPreparation(),base={id:'preset',creatorId:'creator',name:'Reusable',revision:1,applicability:{arrangement:'work',media:'image'},settings,isDefault:false};
 for(const block of [{id:'media',type:'image',assetId:'original'},{id:'link',type:'paragraph',url:'https://private.example?token=secret'},{id:'message',type:'paragraph',text:'https://private.example?token=secret'}])assert.throws(()=>captureContentPreset({...base,settings:{...settings,announce:{...settings.announce,template:{blocks:[block]}}}}));
});
test('Work subjects can reserve a new component revision without repeating an already exposed revision',async()=>{
 const {reserveCollectionRelease}=await import('../dist/index.js');
 const baseline={tenantId:'tenant',creatorId:'creator',collectionId:'work-scope',schemaVersion:1,revision:1,initialized:true,releasedWorkIds:['work'],evidence:[{workId:'work',destinationKey:'native',contentRevision:'1',evidenceReference:'prior'}],initialReleaseId:'original',reservations:[]};
 assert.equal(reserveCollectionRelease({baseline,expectedRevision:1,releaseId:'repeat',requestedWorkIds:['work'],requestedRevisions:[{workId:'work',contentRevision:'1'}]}).state,'noop');
 const next=reserveCollectionRelease({baseline,expectedRevision:1,releaseId:'components',requestedWorkIds:['work'],requestedRevisions:[{workId:'work',contentRevision:'2'}]});assert.equal(next.state,'reserved');assert.equal(next.reservation.kind,'additions');assert.deepEqual(next.reservation.workIds,['work']);
});
