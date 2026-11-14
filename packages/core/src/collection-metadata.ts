import {limitedRichTextToPlainText,sanitizeLimitedRichText} from './profile-content.js';

/** Saved cover references remain opaque; storage custody belongs to host adapters. */
export type CollectionCoverFormat='collection_2x'|'collection_1x'|'profile';
export interface MetadataCoverImage {
  format?:CollectionCoverFormat;fit?:'contain'|'cover';sourceKey:string;
  renditionKeys:{desktop:string;tablet:string;mobile:string};focalPoint:{x:number;y:number};
  zoom?:number;sourceWorkId?:string;altText?:string;updatedAt:string;
}
/** Structural catalogue boundary. Generic updates preserve the caller's other fields. */
export interface MetadataCollectionRecord {
  tenantId:string;creatorId:string;collectionId:string;title:string;description?:string;
  coverImage?:MetadataCoverImage;coverAssetId?:string;revision?:number;metadataRevision?:number;
  publicMetadata?:MetadataValues;updatedAt:string;
}


/** These contracts deliberately have no Work, membership, ordering or access operations. */
export const metadataFields = ['title', 'description', 'cover'] as const;
export type MetadataField = typeof metadataFields[number];
export type MetadataPolicy = 'ON_REQUEST' | 'APPROVAL_REQUIRED' | 'AUTOMATIC';
export type MetadataRole = 'RELATED' | 'SOURCE' | 'DESTINATION';
export type MetadataCover = {kind:'native'; image:NonNullable<MetadataCollectionRecord['coverImage']>}
  | {kind:'asset'; assetId:string} | {kind:'remote'; url:string; identity:string};
export type MetadataValue = string | MetadataCover | null;
export type MetadataValues = Record<MetadataField, MetadataValue>;
export type MetadataCell = {available:true; value:MetadataValue} | {available:false; reason:string};
export type MetadataCells = Record<MetadataField, MetadataCell>;
export type MetadataErrorCode = 'stale_revision'|'remote_conflict'|'unsupported_field'|'unavailable_value'|'permission_denied'|'destination_writer_exists'|'cycle_detected'|'route_paused'|'invalid_request'|'storage_budget';
export class CollectionMetadataError extends Error {
  constructor(readonly code:MetadataErrorCode, message:string) { super(message); }
}
export function metadataError(code:MetadataErrorCode, message:string):never {throw new CollectionMetadataError(code,message);}
export interface MetadataEndpoint {
  kind:'platform'|'native-publication'|'website';
  /** Stable identity. Credential connection IDs and display labels are never endpoint identities. */
  identity:string;
  platform:string;
  accountId?:string;
  remoteAccountId?:string;
  remoteCollectionId:string;
  title:string;
  accountLabel?:string;
  url?:string;
}
export interface MetadataCapabilities {
  revision:string;
  fields:Record<MetadataField,{readable:boolean; writable:boolean; clearable:boolean}>;
  automatic:boolean;
  reason?:string;
  freshnessMs:number;
  conditionalWrite:boolean;
  emptyCreation:boolean;
}
export interface MetadataSnapshot {
  rawFields?:MetadataCells;
  id:string; endpointIdentity:string; observedAt:string; remoteVersion?:string;
  fields:MetadataCells; hashes:Partial<Record<MetadataField,string>>;
}
export interface FieldBaseline {snapshotId:string; hash:string; value:MetadataValue}
export interface MetadataConnection {
  id:string; endpoint:MetadataEndpoint; role:MetadataRole; revision:number;
  lifecycle:'ACTIVE'|'PAUSED'|'DETACHED'; fields:MetadataField[]; policy?:MetadataPolicy;
  overrides:Partial<MetadataValues>; baseline:Partial<Record<MetadataField,FieldBaseline>>;
  latestSnapshotId?:string; capabilityRevision?:string;
  actorId:string; createdAt:string; lastAppliedAt?:string; attention?:string;
  /** A policy is authorized only after the initial exact-value review. */
  activated:boolean;
  rejected:Partial<Record<MetadataField,string>>;
}
export type ProposalState = 'PENDING'|'QUEUED'|'RUNNING'|'APPLIED'|'REJECTED'|'SUPERSEDED'|'BLOCKED'|'PARTIAL'|'FAILED';
export interface MetadataChange {field:MetadataField; previous:MetadataValue; proposed:MetadataValue; observedHash:string; blocked?:string}
export interface MetadataProposal {
  id:string; connectionId:string; direction:'INCOMING'|'OUTGOING'|'COPY';
  configurationRevision:number; nativeRevision:number; nativeHash:string;
  remoteSnapshotId:string; capabilityRevision:string; changes:MetadataChange[];
  state:ProposalState; actorId:string; createdAt:string; appliedAt?:string; error?:string;
  attempts:number; idempotencyKey:string; outcomes:Partial<Record<MetadataField,'APPLIED'|'BLOCKED'|'FAILED'>>;
  configuration?:MetadataConnection;
  continuationNativeRevision?:number; continuationNativeHash?:string; executionConfigurationRevision?:number;
}
export interface MetadataAudit {id:string; actorId:string; event:string; at:string; connectionId?:string; proposalId?:string; nativeRevision:number; outcome?:string}
export interface MetadataExecution {id:string;proposalId:string;connectionId:string;idempotencyKey:string;attempt:number;at:string;state:'APPLIED'|'PARTIAL'|'BLOCKED'|'FAILED';outcomes:MetadataProposal['outcomes'];nativeRevision:number;errorCode?:MetadataErrorCode}
export interface MetadataProvenance {id:string; endpoint:MetadataEndpoint; importedAt:string; fields:MetadataField[]; snapshotId:string; actorId:string}
export interface MetadataState {
  legacyMigrated?:boolean;
  revision:number; initialized:boolean; connections:MetadataConnection[]; snapshots:MetadataSnapshot[];
  proposals:MetadataProposal[]; provenance:MetadataProvenance[]; audit:MetadataAudit[];
  executions:MetadataExecution[];
  commands:Array<{id:string; hash:string; resultId?:string}>;
  /** Published projections are independent of the editable native catalogue record. */
  published:Record<string,{values:MetadataValues; nativeRevision:number; updatedAt:string}>;
}
export interface MetadataGraph {
  revision:number;
  routes:Array<{connectionId:string; collectionId:string; from:string; to:string; fields:MetadataField[]; role:'SOURCE'|'DESTINATION'}>;
}
export interface MetadataCommit<C extends MetadataCollectionRecord=MetadataCollectionRecord> {
  tenantId:string; creatorId:string; collectionId:string; expectedRevision:number; state:MetadataState;
  expectedCollectionRevision:number; collection?:C;
  graph?:MetadataGraph; expectedGraphRevision?:number;
  expectedOrganizationRevision?:number;
  permissions?:Array<{actorId:string;admin:boolean;role?:string}>;
}
export interface CollectionMetadataStore<C extends MetadataCollectionRecord=MetadataCollectionRecord> {
  getCollectionMetadataPresentation(tenantId:string,collectionId:string):Promise<MetadataState['published']>;
  getCollectionMetadata(tenantId:string, collectionId:string):Promise<MetadataState>;
  getCollectionMetadataGraph(tenantId:string):Promise<MetadataGraph>;
  commitCollectionMetadata(input:MetadataCommit<C>):Promise<void>;
}
export const emptyMetadataState = ():MetadataState => ({revision:0, initialized:false, connections:[], snapshots:[], proposals:[], provenance:[], audit:[],executions:[], commands:[], published:{}});
export const emptyMetadataGraph = ():MetadataGraph => ({revision:0,routes:[]});
const stable = (value:unknown):unknown => Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])):value;
export function nativeMetadata(c:MetadataCollectionRecord):MetadataValues {
  return {title:c.title, description:c.description??null, cover:c.coverImage?{kind:'native',image:c.coverImage}:c.coverAssetId?{kind:'asset',assetId:c.coverAssetId}:null};
}
/** Platform collection descriptions currently use plain text, independently of Work extension support. */
export function projectCollectionMetadataValue(field:MetadataField,value:MetadataValue,endpoint:MetadataEndpoint):MetadataValue {
  return field==='description'&&endpoint.kind==='platform'&&typeof value==='string'?collectionDescriptionToPlainText(value):value;
}
export const collectionDescriptionToPlainText=(value:string)=>limitedRichTextToPlainText(value.replace(/<\/(?:p|div|li)\s*>/gi,'<br>'));
export const plainCollectionDescriptionToRichText=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\r\n?|\n/g,'<br>');
export function normalizedMetadata(field:MetadataField, value:MetadataValue):unknown {
  if(field==='description'&&value===null)return '';
  if(typeof value==='string')return value.replace(/\r\n?/g,'\n').normalize('NFC');
  if(field==='cover'&&value&&typeof value==='object'&&value.kind==='native') {
    const {updatedAt, ...image}=value.image; return {kind:value.kind,image};
  }
  return value;
}
export const cellsFromValues=(values:MetadataValues):MetadataCells=>Object.fromEntries(metadataFields.map(f=>[f,{available:true,value:values[f]}])) as MetadataCells;
export function selectedFields(value:unknown):MetadataField[] {
  if(!Array.isArray(value)||value.length===0||value.some(f=>!metadataFields.includes(f)))return metadataError('invalid_request','Choose title, description, or cover.');
  return [...new Set(value)] as MetadataField[];
}
export function assertMetadataPatch(patch:unknown):asserts patch is Partial<MetadataValues> {
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(f=>!metadataFields.includes(f as MetadataField)))metadataError('unsupported_field','Only collection title, description, and cover may be changed.');
  for(const [f,value] of Object.entries(patch as object)) {
    if(f==='title'&&(typeof value!=='string'||!value.trim()||value.length>200))metadataError('invalid_request','Enter a collection title of up to 200 characters.');
    if(f==='description'&&value!==null&&(typeof value!=='string'||value.length>100000||limitedRichTextToPlainText(value).length>20000))metadataError('invalid_request','Enter a description of up to 20,000 text characters.');
    if(f==='cover'&&value!==null) {
      if(!value||typeof value!=='object'||!['native','asset','remote'].includes(value.kind))metadataError('invalid_request','Choose a supported saved cover reference.');
      if(value.kind==='remote'&&(typeof value.identity!=='string'||!value.identity||typeof value.url!=='string'||!value.url.startsWith('https://')))metadataError('invalid_request','Choose a supported secure remote cover.');
      if(value.kind==='asset'&&(typeof value.assetId!=='string'||!value.assetId))metadataError('invalid_request','Choose an existing cover asset.');
      if(value.kind==='native'&&(!value.image?.sourceKey||!value.image?.renditionKeys?.desktop||!value.image?.renditionKeys?.tablet||!value.image?.renditionKeys?.mobile))metadataError('invalid_request','Choose an existing saved collection cover.');
    }
  }
}
export function assertEditableMetadata(c:MetadataCollectionRecord, state:MetadataState, fields:MetadataField[]) {
  const source=state.connections.find(r=>r.role==='SOURCE'&&r.lifecycle!=='DETACHED');
  if(source&&fields.some(f=>source.fields.includes(f)))metadataError('invalid_request',`Change management before editing fields managed on ${source.endpoint.platform}.`);
}
export function reserveMetadataRoute(graph:MetadataGraph, collectionId:string, connection:MetadataConnection, tenantId:string):MetadataGraph {
  const routes=graph.routes.filter(r=>r.connectionId!==connection.id), native=`native:${tenantId}:${collectionId}`;
  if(connection.lifecycle!=='DETACHED'&&connection.role!=='RELATED') {
    const endpoint=connection.endpoint.identity;
    if(connection.role==='DESTINATION'&&routes.some(r=>r.role==='DESTINATION'&&r.to===endpoint&&r.fields.some(f=>connection.fields.includes(f))))metadataError('destination_writer_exists','Another collection already manages these destination fields.');
    const from=connection.role==='SOURCE'?endpoint:native,to=connection.role==='SOURCE'?native:endpoint;
    const reaches=(start:string,target:string,seen=new Set<string>()):boolean=>start===target||(!seen.has(start)&&(seen.add(start),routes.filter(r=>r.from===start).some(r=>reaches(r.to,target,seen))));
    if(reaches(to,from))metadataError('cycle_detected','This configuration would create a metadata update cycle.');
    routes.push({connectionId:connection.id,collectionId,from,to,fields:connection.fields,role:connection.role});
  }
  return {revision:graph.revision+1,routes};
}
export function validateMetadataCommit<C extends MetadataCollectionRecord>(input:MetadataCommit<C>) {
  if(input.state.revision!==input.expectedRevision+1)metadataError('stale_revision','Metadata configuration changed. Refresh before retrying.');
  if(input.collection&&(input.collection.collectionId!==input.collectionId||input.collection.tenantId!==input.tenantId||input.collection.creatorId!==input.creatorId||input.collection.revision!==input.expectedCollectionRevision+1))metadataError('stale_revision','Collection ownership or revision changed.');
  if(input.graph&&input.graph.revision!==(input.expectedGraphRevision??0)+1)metadataError('stale_revision','Metadata route ownership changed.');
}

/** Trusted server composition supplies actual SHA-256 over UTF-8 and its ID/clock
 * sources. These ports are never accepted from an HTTP request. Keeping Node
 * cryptography outside this module preserves browser-safe core exports. */
export interface MetadataDomainPorts {
  sha256Hex(value:string):string;
  createId():string;
  now():string;
}
export function createMetadataDomain(ports:MetadataDomainPorts){
  if(typeof ports?.sha256Hex!=='function'||typeof ports?.createId!=='function'||typeof ports?.now!=='function')throw new Error('Metadata hashing, ID and clock ports are required.');
  const {sha256Hex,createId,now}=ports;
  const metadataHash = (value:unknown):string => sha256Hex(JSON.stringify(stable(value)));
  const fieldHash=(field:MetadataField,value:MetadataValue)=>metadataHash(normalizedMetadata(field,value));
  function metadataSnapshot(endpointIdentity:string, fields:MetadataCells, remoteVersion?:string):MetadataSnapshot {
    return {id:createId(),endpointIdentity,fields:structuredClone(fields),remoteVersion,observedAt:now(),
      hashes:Object.fromEntries(metadataFields.flatMap(f=>fields[f].available?[[f,fieldHash(f,fields[f].value)]]:[]))};
  }
  function planMetadata(c:MetadataCollectionRecord, connection:MetadataConnection, snapshot:MetadataSnapshot, capabilities:MetadataCapabilities, actorId:string, direction:'INCOMING'|'OUTGOING'|'COPY'=connection.role==='DESTINATION'?'OUTGOING':'INCOMING'):MetadataProposal {
    if(connection.lifecycle!=='ACTIVE')metadataError('route_paused','Resume this route and refresh its comparison before applying changes.');
    const native=nativeMetadata(c), changes:MetadataChange[]=[];
    for(const field of connection.fields) {
      const cell=snapshot.fields[field];
      if(!cell.available)continue; // Unknown is never an instruction to clear.
      const outgoing=direction==='OUTGOING',desired=projectCollectionMetadataValue(field,outgoing?(Object.prototype.hasOwnProperty.call(connection.overrides,field)?connection.overrides[field]!:native[field]):cell.value,connection.endpoint);
      const previous=outgoing?cell.value:native[field];
      const previousHash=fieldHash(field,projectCollectionMetadataValue(field,previous,connection.endpoint));
      if(previousHash===fieldHash(field,desired))continue;
      if(connection.rejected[field]===metadataHash([snapshot.hashes[field],fieldHash(field,desired)]))continue;
      const support=capabilities.fields[field];
      let blocked:string|undefined;
      if(!support.readable||outgoing&&!support.writable)blocked='This field is unavailable in the installed adapter.';
      else if(outgoing&&(desired===null||desired==='')&&!support.clearable)blocked='This destination cannot clear this field.';
      const baseline=connection.baseline[field];
      if(!baseline&&connection.activated&&connection.policy==='AUTOMATIC')blocked='An initial baseline is unavailable for this field. Review its first change explicitly.';
      if(baseline&&direction!=='COPY') {
        const remoteChanged=baseline.hash!==snapshot.hashes[field];
        if(outgoing&&remoteChanged)blocked='The destination was edited directly. Review this conflict.';
        else if(!outgoing&&previousHash!==baseline.hash)blocked='Native metadata changed since the accepted source baseline. Review this conflict.';
      }
      changes.push({field,previous,proposed:desired,observedHash:snapshot.hashes[field]!,blocked});
    }
    const id=createId();
    return {id,connectionId:connection.id,direction,configurationRevision:connection.revision,nativeRevision:c.metadataRevision??0,nativeHash:metadataHash(native),remoteSnapshotId:snapshot.id,capabilityRevision:capabilities.revision,changes,state:changes.some(ch=>ch.blocked)?'BLOCKED':'PENDING',actorId,createdAt:now(),attempts:0,idempotencyKey:metadataHash([connection.id,connection.revision,c.metadataRevision,changes]),outcomes:{}};
  }
  function applyNativeMetadata<C extends MetadataCollectionRecord>(c:C, patch:Partial<MetadataValues>):C {
    assertMetadataPatch(patch);
    const updated={...c,publicMetadata:c.publicMetadata??nativeMetadata(c),revision:(c.revision??0)+1,metadataRevision:(c.metadataRevision??0)+1,updatedAt:now()};
    if(patch.title!==undefined)updated.title=patch.title as string;
    if(patch.description!==undefined)updated.description=patch.description===null?undefined:sanitizeLimitedRichText(patch.description,20000)??'';
    if(patch.cover!==undefined) {
      updated.coverImage=undefined;updated.coverAssetId=undefined;
      if(patch.cover&&typeof patch.cover==='object') {
        if(patch.cover.kind==='native')updated.coverImage=patch.cover.image;
        else if(patch.cover.kind==='asset')updated.coverAssetId=patch.cover.assetId;
        else metadataError('unsupported_field','This remote cover cannot be stored safely by the installed asset adapter.');
      }
    }
    return updated; // Slug, membership, visibility and internal metadata are preserved.
  }
  return Object.freeze({metadataHash,fieldHash,metadataSnapshot,planMetadata,applyNativeMetadata});
}
