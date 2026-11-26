import {metadataError,reserveMetadataRoute,selectedFields,type createMetadataDomain,type MetadataConnection,type MetadataEndpoint,type MetadataGraph,type MetadataState} from './collection-metadata.js';
import type {createMetadataService,MetadataServiceCollection} from './collection-metadata-service.js';

export interface MetadataCommandResult<C extends MetadataServiceCollection> {
  collection?:C;graph?:MetadataGraph;expectedGraphRevision?:number;resultId?:string;
}
/** Trusted host bindings. Authorization is current and tenant/Creator scoped;
 * recorded actors still require conditional guards in the host's atomic commit. */
export interface MetadataCommandPorts<C extends MetadataServiceCollection,R> {
  service:ReturnType<typeof createMetadataService<C,R>>;
  domain:Pick<ReturnType<typeof createMetadataDomain>,'fieldHash'|'metadataHash'|'planMetadata'>;
  createId():string;
  now():string;
  tenantId(runtime:R):string;
  enabled(runtime:R):boolean;
  authorize(runtime:R,collection:C,actorId:string):Promise<void>;
  recordAuthorization(runtime:R,actorId:string):void;
  getGraph(runtime:R):Promise<MetadataGraph>;
  endpoints(runtime:R,collection:C,actorId:string):Promise<MetadataEndpoint[]>;
}

/** Executes a metadata-only command against an explicitly private working copy.
 * There is no persistence, lease, receipt, Work publishing or membership port.
 * Hosts own authenticated HTTP, replay/version checks, signed imports, leases and
 * atomic collection/metadata/organization/graph/all-actor commits. Discard a
 * working copy if execution throws; never save a partly evaluated command. */
export function createMetadataCommandProcessor<C extends MetadataServiceCollection,R>(ports:MetadataCommandPorts<C,R>) {
  for(const key of ['createId','now','tenantId','enabled','authorize','recordAuthorization','getGraph','endpoints'] as const)if(typeof ports?.[key]!=='function')throw new Error(`Metadata command host port ${key} is required.`);
  for(const key of ['metadataAudit','metadataConnection','migrateLegacyMetadataRelationships','observeMetadata','evaluateMetadataObservation','previewMetadataConfiguration','addMetadataProposal','applyMetadataProposal'] as const)if(typeof ports.service?.[key]!=='function')throw new Error(`Metadata command service ${key} is required.`);
  for(const key of ['fieldHash','metadataHash','planMetadata'] as const)if(typeof ports.domain?.[key]!=='function')throw new Error(`Metadata command domain ${key} is required.`);
  const {metadataAudit,metadataConnection,migrateLegacyMetadataRelationships,observeMetadata,evaluateMetadataObservation,previewMetadataConfiguration,addMetadataProposal,applyMetadataProposal}=ports.service;
  const {fieldHash,metadataHash,planMetadata}=ports.domain;
  async function execute(runtime:R,c:C,state:MetadataState,actor:string,operation:string,body:Record<string,any>={}):Promise<MetadataCommandResult<C>> {
    if(!ports.enabled(runtime))metadataError('unsupported_field','Collection metadata management is not enabled.');
    await ports.authorize(runtime,c,actor);ports.recordAuthorization(runtime,actor);
    if(c.status==='archived'||c.status==='deleted'||c.managementState==='archived')metadataError('route_paused','Restore the collection before changing metadata relationships.');
    await migrateLegacyMetadataRelationships(runtime,c,state,actor);
    let updated:C|undefined,graph:MetadataGraph|undefined,expectedGraphRevision:number|undefined,resultId:string|undefined;
      if(operation==='initialize') {
        // Versioned, metadata-only migration. No observation or content jobs are run.
      }else if(operation==='relate') {
        const endpoint=(await ports.endpoints(runtime,c,actor)).find(e=>e.identity===body.endpointIdentity);
        if(!endpoint)metadataError('permission_denied','Choose an authorized existing collection.');
        const existing=state.connections.find(c=>c.endpoint.identity===endpoint.identity&&c.lifecycle!=='DETACHED');
        const connection:MetadataConnection=existing??{id:ports.createId(),endpoint,role:'RELATED',revision:1,lifecycle:'ACTIVE',fields:[],overrides:{},baseline:{},actorId:actor,createdAt:ports.now(),activated:false,rejected:{}};
        await observeMetadata(runtime,c,state,connection,actor);if(!existing)state.connections.push(connection);resultId=connection.id;
        metadataAudit(state,c,actor,'metadata.related',connection.id);
      }else if(operation==='refresh') {
        const connection=metadataConnection(state,body.connectionId);
        try {await observeMetadata(runtime,c,state,connection,actor);const applied=await evaluateMetadataObservation(runtime,c,state,connection,actor);updated=applied?.collection;}
        catch(error){connection.lifecycle='PAUSED';connection.revision++;connection.activated=false;connection.attention=error instanceof Error?error.message:'The endpoint could not be read.';for(const p of state.proposals.filter(p=>p.connectionId===connection.id&&['PENDING','QUEUED','RUNNING'].includes(p.state)))p.state='BLOCKED';}
        metadataAudit(state,c,actor,'metadata.observed',connection.id,undefined,connection.attention);
      }else if(operation==='configure-preview') {
        const connection=metadataConnection(state,body.connectionId);
        resultId=(await previewMetadataConfiguration(runtime,c,state,connection,body,actor)).id;
        metadataAudit(state,c,actor,'metadata.configuration.previewed',connection.id,resultId);
      }else if(operation==='propose'||operation==='copy-preview') {
        const connection=metadataConnection(state,body.connectionId);
        if(operation==='propose'&&connection.role==='RELATED')metadataError('invalid_request','Configure a source or destination, or choose Copy selected metadata here.');
        if(body.reviewAgain===true)connection.rejected={};
        const observed=await observeMetadata(runtime,c,state,connection,actor);
        const planned={...connection,fields:body.fields?selectedFields(body.fields):operation==='copy-preview'?selectedFields(body.fields):connection.fields};
        if(operation==='propose'&&planned.fields.some(f=>!connection.fields.includes(f)))metadataError('invalid_request','Choose fields managed by this route.');
        if(operation==='copy-preview') {
          const source=state.connections.find(r=>r.role==='SOURCE'&&r.lifecycle!=='DETACHED');
          if(source&&planned.fields.some(f=>source.fields.includes(f)))metadataError('invalid_request','Make these fields Managed here before copying metadata.');
        }
        const p=addMetadataProposal(state,planMetadata(c,planned,observed.snapshot,observed.capabilities,actor,operation==='copy-preview'?'COPY':connection.role==='DESTINATION'?'OUTGOING':'INCOMING'));resultId=p.id;
        metadataAudit(state,c,actor,'metadata.proposal.requested',connection.id,p.id);
      }else if(operation==='apply') {
        const p=state.proposals.find(p=>p.id===body.proposalId);if(!p)metadataError('invalid_request','Choose an existing proposal.');
        const applied=await applyMetadataProposal(runtime,c,state,p,actor,body);updated=applied.collection;graph=applied.graph;expectedGraphRevision=applied.expectedGraphRevision;resultId=p.id;
      }else if(operation==='reject') {
        const p=state.proposals.find(p=>p.id===body.proposalId&&['PENDING','BLOCKED','PARTIAL'].includes(p.state));if(!p)metadataError('stale_revision','This proposal is no longer awaiting review.');
        const connection=metadataConnection(state,p.connectionId);
        for(const change of p.changes)connection.rejected[change.field]=metadataHash([change.observedHash,fieldHash(change.field,change.proposed)]);
        p.state='REJECTED';metadataAudit(state,c,actor,'metadata.proposal.rejected',connection.id,p.id);
      }else if(operation==='pause'||operation==='detach'||operation==='resume') {
        const connection=metadataConnection(state,body.connectionId);
        connection.lifecycle=operation==='detach'?'DETACHED':operation==='pause'?'PAUSED':'ACTIVE';connection.activated=false;connection.revision++;
        for(const p of state.proposals.filter(p=>p.connectionId===connection.id&&['PENDING','QUEUED','RUNNING','PARTIAL','BLOCKED'].includes(p.state)))p.state='SUPERSEDED';
        const before=await ports.getGraph(runtime);expectedGraphRevision=before.revision;graph=reserveMetadataRoute(before,c.collectionId,connection,ports.tenantId(runtime));
        if(operation==='resume'){const observed=await observeMetadata(runtime,c,state,connection,actor);if(connection.role!=='RELATED')resultId=addMetadataProposal(state,planMetadata(c,connection,observed.snapshot,observed.capabilities,actor)).id;}
        metadataAudit(state,c,actor,`metadata.connection.${operation}`,connection.id);
      }else metadataError('invalid_request','Unknown metadata operation.');
    return {collection:updated,graph,expectedGraphRevision,resultId};
  }
  return Object.freeze({execute});
}
