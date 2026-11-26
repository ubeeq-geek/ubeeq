import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultContentPreparation,captureContentPreset} from '@ubeeq/core';
import {portableContentPreparations,validateContentPreparationArchive} from '../dist/index.js';
const parent={kind:'collection',id:'parent',revision:2},child={kind:'collection',id:'child',revision:3};
function draft(){return {id:'preparation',schemaVersion:1,tenantId:'tenant',creatorId:'creator',actorId:'owner',revision:2,state:'draft',entry:{intent:'add',target:parent},units:[parent],objects:[{id:'included',operationId:'include',filename:'Child',media:'mixed',role:'original',state:'reference',existingCollection:child,targets:[],provenance:'existing'}],hierarchy:{children:[child],state:'draft'},title:'Volume',collectionType:'volume',arrangement:'collection',arrangementConfirmed:true,previews:[],operationIds:['executed'],settings:{...defaultContentPreparation(),commerceOffer:{id:'offer-authority',environment:'live'},offerId:'bound-offer',metadata:{shared:{tags:['reusable']},overrides:[{destination:'provider',accountId:'private-account',targetIds:['private-target'],values:{allowComments:false}}]},publishDestinations:[{destination:'provider',connectionId:'private-account',targetId:'private-target',representation:'full',imageVariant:'share',required:true}]}};}
test('portable preparations retain grouping references and image choices while removing offer/account authority',()=>{
 const source=draft(),preset=captureContentPreset({id:'preset',creatorId:'creator',name:'Volumes',revision:1,applicability:{arrangement:'collection',collectionType:'volume',media:'mixed'},settings:source.settings,isDefault:true});
 const archive=portableContentPreparations([source],[preset]),encoded=JSON.stringify(archive);
 for(const id of ['offer-authority','bound-offer','private-account','private-target','executed'])assert.equal(encoded.includes(id),false);
 assert.deepEqual(archive.drafts[0].hierarchy.children,[child]);assert.equal(archive.drafts[0].settings.publishDestinations[0].imageVariant,'share');assert.equal(archive.presets[0].isDefault,false);
});
test('restored hierarchy rejects missing child groupings before any execution authority can be adopted',()=>{
 const archive=portableContentPreparations([draft()],[]),scope={tenantId:'tenant',creatorId:'creator'};
 assert.throws(()=>validateContentPreparationArchive(archive,scope,{workIds:new Set(),collectionIds:new Set(['parent'])}),/missing content/);
 assert.equal(validateContentPreparationArchive(archive,scope,{workIds:new Set(),collectionIds:new Set(['parent','child'])}).drafts[0].state,'draft');
});
