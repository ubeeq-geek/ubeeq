import {assertEditableMetadata,assertMetadataPatch,metadataError,nativeMetadata,plainCollectionDescriptionToRichText,projectCollectionMetadataValue,reserveMetadataRoute,selectedFields,
  type createMetadataDomain,type MetadataCollectionRecord,type MetadataCapabilities,type MetadataConnection,type MetadataEndpoint,type MetadataField,type MetadataGraph,type MetadataPolicy,type MetadataProposal,type MetadataSnapshot,type MetadataState,type MetadataValues} from './collection-metadata.js';

export interface MetadataServiceCollection extends MetadataCollectionRecord {status?:string;managementState?:string}
/** Metadata reads only: this port cannot publish Works, change access, or reorder content. */
export interface MetadataReadAdapter {
  capabilities(endpoint:MetadataEndpoint):MetadataCapabilities;
  readCollectionMetadata(endpoint:MetadataEndpoint):Promise<MetadataSnapshot>;
}
/** Required host boundaries; no permission, publication or legacy-adoption defaults. */
export interface MetadataServicePorts<C extends MetadataServiceCollection,R> {
  domain:Omit<ReturnType<typeof createMetadataDomain>,'applyNativeMetadata'>&{
    applyNativeMetadata(collection:C,patch:Partial<MetadataValues>):C;
  };
  createId():string;
  now():string;
  tenantId(runtime:R):string;
  enabled(runtime:R):boolean;
  canManage(runtime:R,creatorId:string,actorId:string):Promise<boolean>;
  recordAuthorization(runtime:R,actorId:string):void;
  getGraph(runtime:R):Promise<MetadataGraph>;
  adapter(runtime:R,collection:C,state:MetadataState,actorId:string,endpoint:MetadataEndpoint):Promise<MetadataReadAdapter>;
  /** Must enforce current release, destination admission and publication policy. */
  validateDestination(runtime:R,collection:C,connection:MetadataConnection):Promise<void>;
  publicationIdentity(tenantId:string,collectionId:string,destination:string):string;
  /** Discovery is Related only. It never infers import provenance or automation. */
  legacyRelationships(runtime:R,collection:C):Promise<{endpoints:MetadataEndpoint[];publications:Array<{destination:string}>}>;
}

/** Plans and mutates a private working state. The host still owns leases and atomic guarded commits. */
export function createMetadataService<C extends MetadataServiceCollection,R>(ports:MetadataServicePorts<C,R>) {
  const {applyNativeMetadata,fieldHash,metadataHash,metadataSnapshot,planMetadata}=ports.domain;
  const canRunMetadata=(runtime:R,creatorId:string,actorId:string)=>ports.canManage(runtime,creatorId,actorId);
  const validateMetadataDestination=(runtime:R,c:C,connection:MetadataConnection)=>ports.validateDestination(runtime,c,connection);
  const latestMetadataSnapshot=(state:MetadataState,connection:MetadataConnection)=>state.snapshots.find(s=>s.id===connection.latestSnapshotId);
  const unavailableCapabilities=(reason:string):MetadataCapabilities=>({revision:metadataHash(reason),fields:{title:{readable:false,writable:false,clearable:false},description:{readable:false,writable:false,clearable:false},cover:{readable:false,writable:false,clearable:false}},automatic:false,reason,freshnessMs:0,conditionalWrite:false,emptyCreation:false});
function metadataAudit(state:MetadataState,c:C,actorId:string,event:string,connectionId?:string,proposalId?:string,outcome?:string) {
  state.audit.push({id:ports.createId(),actorId,event,at:ports.now(),connectionId,proposalId,nativeRevision:c.metadataRevision??0,outcome});
}
function metadataConnection(state:MetadataState,id:unknown):MetadataConnection {
  const connection=state.connections.find(c=>c.id===id&&c.lifecycle!=='DETACHED');
  return connection??metadataError('invalid_request','Choose an existing metadata relationship.');
}
function recordMetadataObservation(state:MetadataState,connection:MetadataConnection,snapshot:ReturnType<typeof metadataSnapshot>) {
  state.snapshots.push(snapshot);connection.latestSnapshotId=snapshot.id;
  // An identical poll does not invalidate exact-value approval.
  for(const p of state.proposals.filter(p=>p.connectionId===connection.id&&['PENDING','BLOCKED','QUEUED'].includes(p.state))) {
    if(p.changes.some(ch=>snapshot.hashes[ch.field]!==ch.observedHash))p.state='SUPERSEDED';
  }
}
function initializeMetadata(state:MetadataState,c:C,tenantId:string,publications:Array<{destination:string}>) {
  if(state.initialized)return;
  for(const p of publications)state.published[ports.publicationIdentity(tenantId,c.collectionId,p.destination)]={values:c.publicMetadata??nativeMetadata(c),nativeRevision:c.metadataRevision??0,updatedAt:ports.now()};
  state.initialized=true;
}
/** Generic legacy links authorize no metadata updates. Never fabricate import provenance. */
async function migrateLegacyMetadataRelationships(runtime:R,c:C,state:MetadataState,actorId:string) {
  if(state.legacyMigrated)return;
  const {endpoints,publications}=await ports.legacyRelationships(runtime,c);
  for(const endpoint of endpoints)if(!state.connections.some(r=>r.endpoint.identity===endpoint.identity&&r.lifecycle!=='DETACHED'))state.connections.push({id:ports.createId(),endpoint,role:'RELATED',revision:1,lifecycle:'ACTIVE',fields:[],overrides:{},baseline:{},rejected:{},actorId,createdAt:ports.now(),activated:false,attention:'Setup required. Existing collection-content controls remain separate.'});
  initializeMetadata(state,c,ports.tenantId(runtime),publications);
  metadataAudit(state,c,actorId,'metadata.legacy.relationships.recorded',undefined,undefined,'Related only; no automation or import provenance inferred.');
  state.legacyMigrated=true;
}
async function observeMetadata(runtime:R,c:C,state:MetadataState,connection:MetadataConnection,actorId:string) {
  const adapter=await ports.adapter(runtime,c,state,actorId,connection.endpoint);
  const snapshot=await adapter.readCollectionMetadata(connection.endpoint);
  recordMetadataObservation(state,connection,snapshot);connection.attention=undefined;
  return {snapshot,capabilities:adapter.capabilities(connection.endpoint)};
}
function addMetadataProposal(state:MetadataState,p:MetadataProposal) {
  const existing=state.proposals.find(old=>old.connectionId===p.connectionId&&old.direction===p.direction&&old.configurationRevision===p.configurationRevision&&metadataHash(old.changes)===metadataHash(p.changes)&&old.nativeRevision===p.nativeRevision&&Boolean(old.configuration)===Boolean(p.configuration)&&['PENDING','BLOCKED'].includes(old.state));
  if(existing)return existing;
  for(const previous of state.proposals.filter(old=>old.connectionId===p.connectionId&&old.direction===p.direction&&Boolean(old.configuration)===Boolean(p.configuration)&&['PENDING','BLOCKED','QUEUED'].includes(old.state)))previous.state='SUPERSEDED';
  state.proposals.push(p);return p;
}
function acceptEquivalentFields(c:C,connection:MetadataConnection,snapshot:ReturnType<typeof metadataSnapshot>) {
  const native=nativeMetadata(c);
  for(const f of connection.fields) {
    const cell=snapshot.fields[f],desired=connection.role==='DESTINATION'&&Object.prototype.hasOwnProperty.call(connection.overrides,f)?connection.overrides[f]!:native[f];
    if(cell.available&&fieldHash(f,cell.value)===fieldHash(f,projectCollectionMetadataValue(f,desired,connection.endpoint)))connection.baseline[f]={snapshotId:snapshot.id,hash:snapshot.hashes[f]!,value:cell.value};
  }
}
async function previewMetadataConfiguration(runtime:R,c:C,state:MetadataState,connection:MetadataConnection,input:Record<string,any>,actorId:string):Promise<MetadataProposal> {
  if(!['RELATED','SOURCE','DESTINATION'].includes(input.role))metadataError('invalid_request','Choose a metadata relationship role.');
  if(input.role==='SOURCE'&&connection.endpoint.kind==='native-publication')metadataError('unsupported_field','Manage this native catalogue here. Its own public appearance can be a destination or Related only.');
  const fields=input.role==='RELATED'?[]:selectedFields(input.fields);
  const policy=input.role==='RELATED'?undefined:(input.policy??'APPROVAL_REQUIRED') as MetadataPolicy;
  if(policy&&!['ON_REQUEST','APPROVAL_REQUIRED','AUTOMATIC'].includes(policy))metadataError('invalid_request','Choose a supported update policy.');
  const overrides=input.overrides??{};assertMetadataPatch(overrides);
  if(Object.keys(overrides).some(f=>!fields.includes(f as MetadataField))||input.role!=='DESTINATION'&&Object.keys(overrides).length)metadataError('invalid_request','Overrides apply only to selected destination fields.');
  if(input.role==='SOURCE'&&state.connections.some(r=>r.id!==connection.id&&r.role==='SOURCE'&&r.lifecycle!=='DETACHED'))metadataError('invalid_request','Change the existing management source to Related only before selecting another source.');
  const observed=input.role==='RELATED'?(()=>{const capabilities=unavailableCapabilities('No remote authority is needed to stop metadata management.'),snapshot=latestMetadataSnapshot(state,connection)??metadataSnapshot(connection.endpoint.identity,{title:{available:false,reason:'Not checked'},description:{available:false,reason:'Not checked'},cover:{available:false,reason:'Not checked'}});if(!state.snapshots.some(s=>s.id===snapshot.id))state.snapshots.push(snapshot);return {snapshot,capabilities};})():await observeMetadata(runtime,c,state,connection,actorId);
  const {snapshot,capabilities}=observed;
  if(fields.some(f=>!capabilities.fields[f].readable||input.role==='DESTINATION'&&!capabilities.fields[f].writable))metadataError('unsupported_field','One or more selected fields are unavailable in this adapter.');
  if(policy==='AUTOMATIC'&&!capabilities.automatic)metadataError('unsupported_field',capabilities.reason||'Automatic updates are unavailable for this adapter.');
  const next:MetadataConnection={...connection,role:input.role,fields,policy,overrides,revision:connection.revision+1,lifecycle:'ACTIVE',activated:false,baseline:{},rejected:{},actorId,capabilityRevision:capabilities.revision};
  // Reserving in a preview checks conflicts but does not acquire write authority.
  reserveMetadataRoute(await ports.getGraph(runtime),c.collectionId,next,ports.tenantId(runtime));
  const proposal=planMetadata(c,next,snapshot,capabilities,actorId);
  proposal.configurationRevision=connection.revision;proposal.configuration=next;
  // Configuration itself can be saved even if initial data differences require a later review.
  proposal.state='PENDING';
  return addMetadataProposal(state,proposal);
}
async function applyMetadataProposal(runtime:R,c:C,state:MetadataState,p:MetadataProposal,actorId:string,input:{fields?:unknown;applyInitial?:boolean;activate?:boolean}={}):Promise<{collection?:C;graph?:MetadataGraph;expectedGraphRevision?:number}> {
  if(['archived','deleted'].includes(c.status??'')||c.managementState==='archived')metadataError('route_paused','Restore the collection before applying metadata changes.');
  if(!['PENDING','PARTIAL','BLOCKED'].includes(p.state))metadataError('stale_revision','Refresh and review this proposal before applying it.');
  let connection=metadataConnection(state,p.connectionId);
  if(connection.revision!==(p.executionConfigurationRevision??p.configurationRevision)||(c.metadataRevision??0)!==(p.continuationNativeRevision??p.nativeRevision)||metadataHash(nativeMetadata(c))!==(p.continuationNativeHash??p.nativeHash))metadataError('stale_revision','The reviewed native values or configuration changed. Request a fresh preview.');
  if(connection.lifecycle!=='ACTIVE'&&p.configuration?.role!=='RELATED')metadataError('route_paused','This metadata route is paused.');
  if(!await canRunMetadata(runtime,c.creatorId,actorId))metadataError('permission_denied','Collection management permission is required.');
  ports.recordAuthorization(runtime,actorId);
  if(p.configuration?.role==='RELATED') {
    const next=structuredClone(p.configuration),previous=await ports.getGraph(runtime),graph=reserveMetadataRoute(previous,c.collectionId,next,ports.tenantId(runtime));
    for(const old of state.proposals.filter(old=>old.id!==p.id&&old.connectionId===connection.id&&['PENDING','BLOCKED','QUEUED','PARTIAL'].includes(old.state)))old.state='SUPERSEDED';
    Object.assign(connection,next);connection.activated=false;p.state='APPLIED';p.appliedAt=ports.now();
    metadataAudit(state,c,actorId,'metadata.configuration.saved',connection.id,p.id,'Managed here; relationship retained without remote writes.');
    return {graph,expectedGraphRevision:previous.revision};
  }
  const {snapshot,capabilities}=await observeMetadata(runtime,c,state,connection,actorId);
  if(capabilities.revision!==p.capabilityRevision||p.changes.some(ch=>p.outcomes[ch.field]!=='APPLIED'&&snapshot.hashes[ch.field]!==ch.observedHash))metadataError('stale_revision','The observed metadata or adapter capabilities changed. Review a new proposal.');
  const fields=input.fields===undefined?p.changes.filter(ch=>p.outcomes[ch.field]!=='APPLIED').map(ch=>ch.field):selectedFields(input.fields);
  if(fields.some(f=>!p.changes.some(ch=>ch.field===f)))metadataError('invalid_request','Only fields in the displayed proposal can be approved.');
  let graph:MetadataGraph|undefined,expectedGraphRevision:number|undefined;
  if(p.configuration&&!p.executionConfigurationRevision) {
    const next=structuredClone(p.configuration);
    if(next.role==='SOURCE'&&state.connections.some(r=>r.id!==connection.id&&r.role==='SOURCE'&&r.lifecycle!=='DETACHED'))metadataError('stale_revision','Another management source was configured.');
    const previous=await ports.getGraph(runtime);expectedGraphRevision=previous.revision;
    graph=reserveMetadataRoute(previous,c.collectionId,next,ports.tenantId(runtime));
    for(const old of state.proposals.filter(old=>old.id!==p.id&&old.connectionId===connection.id&&['PENDING','BLOCKED','QUEUED','PARTIAL'].includes(old.state)))old.state='SUPERSEDED';
    Object.assign(connection,next);p.executionConfigurationRevision=connection.revision;
    // Establish observed destination baselines without accepting incoming source values.
    if(connection.role==='DESTINATION')for(const f of connection.fields){const cell=snapshot.fields[f];if(cell.available)connection.baseline[f]={snapshotId:snapshot.id,hash:snapshot.hashes[f]!,value:cell.value};}
    if(!input.applyInitial&&p.changes.length) {
      if(input.activate&&connection.policy==='AUTOMATIC')metadataError('invalid_request','Apply the displayed initial changes before enabling Automatic updates.');
      p.state='APPLIED';p.appliedAt=ports.now();
      metadataAudit(state,c,actorId,'metadata.configuration.saved',connection.id,p.id,'Initial differences remain unapplied.');
      return {graph,expectedGraphRevision};
    }
  }
  if(connection.role==='RELATED'&&p.direction!=='COPY'&&!p.configuration)metadataError('invalid_request','Related only connections do not apply updates.');
  const changes=p.changes.filter(ch=>fields.includes(ch.field)&&p.outcomes[ch.field]!=='APPLIED');
  if(changes.some(ch=>ch.blocked))metadataError('remote_conflict','Resolve the displayed field conflicts before applying this proposal.');
  const patch=Object.fromEntries(changes.map(ch=>[ch.field,ch.proposed])) as Partial<MetadataValues>;
  let updated:C|undefined;
  if(p.direction==='OUTGOING'&&connection.role==='DESTINATION') {
    await validateMetadataDestination(runtime,c,connection);
    const values={...(state.published[connection.endpoint.identity]?.values??c.publicMetadata??nativeMetadata(c)),...patch};
    assertMetadataPatch(values);
    // Existing private cover references cannot be promoted into a public URL by metadata publishing.
    if(patch.cover&&typeof patch.cover==='object'&&patch.cover.kind==='asset')metadataError('unsupported_field','Publishing an asset cover requires the existing asset eligibility adapter. Choose an already published collection cover.');
    if(patch.cover&&typeof patch.cover==='object'&&patch.cover.kind==='remote')metadataError('unsupported_field','The native destination cannot publish this remote cover reference safely.');
    if(patch.cover&&typeof patch.cover==='object'&&patch.cover.kind==='native') {
      const cover=patch.cover,known=[nativeMetadata(c).cover,c.publicMetadata?.cover,...Object.values(state.published).map(p=>p.values.cover),...state.snapshots.flatMap(s=>s.fields.cover.available?[s.fields.cover.value]:[])];
      if(!known.some(value=>metadataHash(value??null)===metadataHash(cover)))metadataError('permission_denied','Choose an existing eligible cover belonging to this collection.');
    }
    state.published[connection.endpoint.identity]={values,nativeRevision:c.metadataRevision??0,updatedAt:ports.now()};
  }else if(changes.length) {
    if(p.direction==='COPY')assertEditableMetadata(c,state,changes.map(ch=>ch.field));
    updated=applyNativeMetadata(c,connection.endpoint.kind==='platform'&&typeof patch.description==='string'?{...patch,description:plainCollectionDescriptionToRichText(patch.description)}:patch);
    // Cover copies only use references already belonging to this collection; adapters may add eligibility support later.
    if(patch.cover&&metadataHash(patch.cover)!==metadataHash(nativeMetadata(c).cover))metadataError('unsupported_field','This cover needs an eligible saved asset reference before it can be copied.');
  }
  for(const change of changes) {
    if(p.direction!=='COPY')connection.baseline[change.field]={snapshotId:snapshot.id,hash:fieldHash(change.field,change.proposed),value:change.proposed};
    p.outcomes[change.field]='APPLIED';delete connection.rejected[change.field];
  }
  // Equal fields can establish an accepted baseline without a write.
  if(p.direction!=='COPY')acceptEquivalentFields(updated??c,connection,snapshot);
  const complete=p.changes.every(ch=>p.outcomes[ch.field]==='APPLIED');
  p.state=complete?'APPLIED':'PARTIAL';p.attempts++;p.appliedAt=ports.now();
  connection.lastAppliedAt=p.appliedAt;connection.activated=connection.role!=='RELATED'&&complete&&(input.activate===true||connection.activated||connection.policy!=='AUTOMATIC');
  state.executions.push({id:ports.createId(),proposalId:p.id,connectionId:connection.id,idempotencyKey:p.idempotencyKey,attempt:p.attempts,at:p.appliedAt,state:p.state as 'APPLIED'|'PARTIAL',outcomes:{...p.outcomes},nativeRevision:updated?.metadataRevision??c.metadataRevision??0});
  if(updated){p.continuationNativeRevision=updated.metadataRevision??0;p.continuationNativeHash=metadataHash(nativeMetadata(updated));}
  metadataAudit(state,updated??c,actorId,p.direction==='OUTGOING'?'metadata.destination.applied':'metadata.native.accepted',connection.id,p.id,p.state);
  if(updated){
    await planAcceptedNativeMetadata(runtime,updated,state,actorId);
    if(connection.role==='SOURCE'&&connection.activated&&connection.policy==='APPROVAL_REQUIRED') {
      const remaining=planMetadata(updated,connection,snapshot,capabilities,actorId);
      if(remaining.changes.length)addMetadataProposal(state,remaining);
    }
  }
  return {collection:updated,graph,expectedGraphRevision};
}
/** Accepted revisions only. Pending incoming proposals are never projected to destinations. */
async function planAcceptedNativeMetadata(runtime:R,c:C,state:MetadataState,actorId:string) {
  if(!ports.enabled(runtime))return;
  for(const connection of state.connections.filter(r=>r.role==='DESTINATION'&&r.lifecycle==='ACTIVE'&&r.activated&&r.policy!=='ON_REQUEST')) {
    try {
      if(!await canRunMetadata(runtime,c.creatorId,connection.actorId)){connection.lifecycle='PAUSED';connection.attention='The authorizing creator no longer has publishing permission.';continue;}
      const adapter=await ports.adapter(runtime,c,state,connection.actorId,connection.endpoint),capabilities=adapter.capabilities(connection.endpoint),snapshot=await adapter.readCollectionMetadata(connection.endpoint);
      recordMetadataObservation(state,connection,snapshot);
      const p=addMetadataProposal(state,planMetadata(c,connection,snapshot,capabilities,actorId));
      if(!p.changes.length){acceptEquivalentFields(c,connection,snapshot);p.state='APPLIED';continue;}
      if(connection.policy==='AUTOMATIC'&&capabilities.automatic&&p.state==='PENDING')await applyMetadataProposal(runtime,c,state,p,connection.actorId);
    }catch(error){connection.attention=error instanceof Error?error.message:'Metadata publishing needs review.';metadataAudit(state,c,actorId,'metadata.destination.blocked',connection.id,undefined,'Review required.');}
  }
}
async function evaluateMetadataObservation(runtime:R,c:C,state:MetadataState,connection:MetadataConnection,actorId:string) {
  if(connection.role==='RELATED'||connection.policy==='ON_REQUEST'||!connection.activated||connection.lifecycle!=='ACTIVE')return;
  const snapshot=latestMetadataSnapshot(state,connection);if(!snapshot)return;
  const adapter=await ports.adapter(runtime,c,state,actorId,connection.endpoint);
  const p=addMetadataProposal(state,planMetadata(c,connection,snapshot,adapter.capabilities(connection.endpoint),actorId));
  if(!p.changes.length){acceptEquivalentFields(c,connection,snapshot);p.state='APPLIED';return;}
  if(connection.policy==='AUTOMATIC'&&adapter.capabilities(connection.endpoint).automatic&&p.state==='PENDING')return applyMetadataProposal(runtime,c,state,p,connection.actorId);
}

  return Object.freeze({metadataAudit,metadataConnection,recordMetadataObservation,initializeMetadata,migrateLegacyMetadataRelationships,observeMetadata,addMetadataProposal,previewMetadataConfiguration,applyMetadataProposal,planAcceptedNativeMetadata,evaluateMetadataObservation});
}
