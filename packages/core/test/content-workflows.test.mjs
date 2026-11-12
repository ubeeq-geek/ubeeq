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
test('advanced announcement settings use the existing scheduler and presets remove absolute times and media identities',async()=>{
 const {contentAnnouncementTrigger,resolveAnnouncementCivilTime}=await import('../dist/index.js');
 const civilTime=resolveAnnouncementCivilTime({localDateTime:'2027-01-02T12:00:00',timeZone:'America/Winnipeg'}),binding={provider:'creator-profile',accountId:'creator',connectionId:'native',targetId:'creator',postType:'announcement'};
 const announce={mode:'after_publication',destinationIds:['profile'],delayMs:0,timing:{mode:'at_time',civilTime},latePolicy:{mode:'hold',maximumLatenessMs:3600000},media:{mode:'managed_previews',assets:[{assetId:'private-original-id',altText:'Preview'}]},followUp:{template:{blocks:[{id:'follow',type:'paragraph',text:'More from {{collection.title}}'}]},destinationIds:['profile'],media:{mode:'none'},timing:{mode:'at_time',civilTime,anchor:{mode:'corresponding_destination'}},latePolicy:{mode:'hold',maximumLatenessMs:3600000}}};
 const trigger=contentAnnouncementTrigger(announce,[{binding,settings:{destinationId:'profile'}}],'native-result');assert.equal(trigger.links.primary.destinationKey,'native-result');assert.equal(trigger.timing.civilTime.instant,civilTime.instant);assert.match(trigger.followUp.template.blocks[0].text,/More/);
 const preset=captureContentPreset({id:'advanced',creatorId:'creator',name:'Advanced',revision:1,applicability:{arrangement:'work',media:'image'},settings:{...defaultContentPreparation(),announce},isDefault:false});
 assert.equal(preset.settings.announce.timing.mode,'after_publication');assert.equal(preset.settings.announce.followUp.timing.mode,'delay_after_parent');assert.equal(preset.settings.announce.mediaRequirement,'select_managed_previews');assert.equal(JSON.stringify(preset).includes('private-original-id'),false);assert.equal(JSON.stringify(preset).includes('2027-01-02'),false);
});

test('neutral draft validation retains real destination customizations while release resolution checks actual bindings',async()=>{
 const {validateContentPreparation,contentAnnouncementTrigger,announcementDestinationKey}=await import('../dist/index.js');
 const binding={provider:'discord',accountId:'guild',connectionId:'bot',targetId:'channel',postType:'announcement'},key=announcementDestinationKey(binding),announce={mode:'draft',destinationIds:['selected'],delayMs:0,template:{fields:{seriesName:'Recurring series',eventLabel:'UPDATE',secret:'omit'},blocks:[{id:'message',type:'paragraph',text:'Standard'}],destinationCustomizations:{[key]:{blockOverrides:{message:{id:'message',type:'paragraph',text:'Custom destination copy'}}}}}};
 validateContentPreparation({...defaultContentPreparation(),announce});
 const trigger=contentAnnouncementTrigger(announce,[{binding,settings:{destinationId:'selected'}}],'native');assert.equal(trigger.template.destinationCustomizations[key].blockOverrides.message.text,'Custom destination copy');
 const preset=captureContentPreset({id:'custom',creatorId:'creator',name:'Custom',revision:1,applicability:{arrangement:'work',media:'image'},settings:{...defaultContentPreparation(),announce},isDefault:false});assert.deepEqual(preset.settings.announce.template.fields,{seriesName:'Recurring series',eventLabel:'UPDATE'});
 assert.throws(()=>contentAnnouncementTrigger(announce,[{binding:{...binding,targetId:'different'},settings:{destinationId:'selected'}}],'native'),/selected announcement destination/);
});
test('Volume defaults are selected independently from flat grouping defaults and never contain child content identities',()=>{
 const settings={...defaultContentPreparation(),structure:{collectionType:'volume',order:'intake',cover:'first_eligible_image'}};
 const volume=captureContentPreset({id:'volume',creatorId:'creator',name:'Volumes',revision:1,applicability:{arrangement:'collection',collectionType:'volume',media:'mixed',childIds:['private-child']},settings,isDefault:true});
 assert.equal(JSON.stringify(volume).includes('private-child'),false);
 assert.equal(resolveContentPreset([volume],'creator','collection','mixed',undefined,undefined,'gallery'),undefined);
 assert.equal(resolveContentPreset([volume],'creator','collection','mixed',undefined,undefined,'volume').id,'volume');
 const existing={...object('grouping'),media:'mixed',state:'reference',provenance:'existing',existingCollection:{kind:'collection',id:'child',revision:3}};
 assert.equal(inferContentArrangement({intent:'new'},[existing]).arrangement,'collection');
 assert.equal(contentWorkflowBlockers({title:'Group',entry:{intent:'new'},objects:[existing],settings:defaultContentPreparation(),arrangement:'work',arrangementConfirmed:true})[0].code,'hierarchy_required');
});
test('reusable metadata, exact image choices and commerce terms omit execution and offer bindings',()=>{
 const settings={...defaultContentPreparation(),metadata:{titlePattern:'{creator}: {title}',shared:{tags:['series'],noAi:true},overrides:[{destination:'deviantart',accountId:'creator-account',targetIds:['gallery'],values:{allowComments:false}}]},commerce:{kind:'purchase',amount:'15.00',currency:'CAD',terms:'Personal licence, including future reviewed additions.',supportEmail:'help@example.test',downloads:true,packageDownload:true,futureAdditions:'included',customerId:'private-customer'},commerceOffer:{id:'private-offer',environment:'live'},publishDestinations:[{destination:'deviantart',connectionId:'creator-account',targetId:'gallery',representation:'full',imageVariant:'share',required:true}]};
 const preset=captureContentPreset({id:'terms',creatorId:'creator',name:'Paid',revision:1,applicability:{arrangement:'work',media:'image'},settings,isDefault:false});
 assert.equal(preset.settings.commerce.amount,'15.00');assert.equal(preset.settings.publishDestinations[0].imageVariant,'share');assert.equal(preset.settings.metadata.overrides[0].targetIds[0],'gallery');
 assert.equal(JSON.stringify(preset).includes('private-offer'),false);assert.equal(JSON.stringify(preset).includes('private-customer'),false);
 assert.throws(()=>captureContentPreset({...preset,settings:{...settings,metadata:{shared:{secret:'credential'},overrides:[]}}}));
 assert.throws(()=>captureContentPreset({...preset,settings:{...settings,metadata:{...settings.metadata,titlePattern:'{privateKey}'}}}));
});
test('initial and follow-up managed selections become explicit fresh-media requirements in reusable presets',()=>{
 const settings=defaultContentPreparation(),media={mode:'managed_previews',assets:[{assetId:'private-source',altText:'Preview'}]};
 settings.announce={...settings.announce,destinationIds:['channel'],media,followUp:{destinationIds:['channel'],media,timing:{mode:'delay_after_parent',durationMs:600000,timeZone:'Etc/UTC',anchor:{mode:'corresponding_destination'}},latePolicy:{mode:'hold',maximumLatenessMs:86400000}}};
 const preset=captureContentPreset({id:'media',creatorId:'creator',name:'Media',revision:1,applicability:{arrangement:'work',media:'image'},settings,isDefault:false});
 assert.equal(JSON.stringify(preset).includes('private-source'),false);assert.equal(preset.settings.announce.followUp.mediaRequirement,'select_managed_previews');
});
