import {captureContentPreset,validateContentObjects,validateContentPreparation,type ContentWorkflowDraft,type ContentUnitPreset} from '@ubeeq/core';
export interface ContentPreparationArchive {schemaVersion:1;drafts:ContentWorkflowDraft[];presets:ContentUnitPreset[];destinationBindingsRequireReview:true}
/** Private draft history is portable; accepted review/send authority and storage capabilities are not. */
export function portableContentPreparations(drafts:readonly ContentWorkflowDraft[],presets:readonly ContentUnitPreset[]):ContentPreparationArchive {
  return {schemaVersion:1,destinationBindingsRequireReview:true,drafts:drafts.filter(d=>d.state!=='cancelled').map(source=>{
    const draft=structuredClone(source);delete draft.review;draft.state='draft';draft.actorId='restore-required';draft.operationIds=[];
    draft.settings.releaseTime=undefined;draft.settings.publishDestinations=draft.settings.publishDestinations.map(d=>({...d,connectionId:undefined,targetId:undefined}));draft.settings.announce.destinationIds=[];draft.settings.announce.mode=draft.settings.announce.mode==='off'?'off':'draft';
    return draft;
  }),presets:presets.map(source=>{const preset=captureContentPreset({...source,settings:{...source.settings,publishDestinations:source.settings.publishDestinations.map(d=>({...d,connectionId:undefined,targetId:undefined})),announce:{...source.settings.announce,destinationIds:[],mode:source.settings.announce.mode==='off'?'off':'draft'}}});return {...preset,isDefault:false,archived:source.archived};})};
}
export function validateContentPreparationArchive(value:unknown,scope:{tenantId:string;creatorId:string},references?:{workIds:ReadonlySet<string>;collectionIds:ReadonlySet<string>}):ContentPreparationArchive {
  const archive=value as ContentPreparationArchive;
  if(!archive||archive.schemaVersion!==1||archive.destinationBindingsRequireReview!==true||!Array.isArray(archive.drafts)||!Array.isArray(archive.presets)||archive.drafts.length>1000||archive.presets.length>1000||new Set(archive.drafts.map(d=>d.id)).size!==archive.drafts.length||new Set(archive.presets.map(p=>`${p.id}:${p.revision}`)).size!==archive.presets.length)throw Error('Invalid preparation archive.');
  for(const draft of archive.drafts){
    if(!draft||draft.creatorId!==scope.creatorId||draft.tenantId!==scope.tenantId||draft.schemaVersion!==1||typeof draft.id!=='string'||!Number.isSafeInteger(draft.revision)||draft.revision<1||!Array.isArray(draft.units)||!Array.isArray(draft.previews)||draft.review||draft.state!=='draft')throw Error('Invalid portable preparation.');
    validateContentObjects(draft.objects);validateContentPreparation(draft.settings);
    for(const ref of [...draft.units,...(draft.entry.target?[draft.entry.target]:[])])if(references&&!(ref.kind==='work'?references.workIds:references.collectionIds).has(ref.id))throw Error('Preparation references missing content.');
  }
  for(const preset of archive.presets){if(preset.creatorId!==scope.creatorId)throw Error('Foreign portable preset.');captureContentPreset(preset);}
  return portableContentPreparations(archive.drafts,archive.presets);
}
