import {createHash} from 'node:crypto';
import {GetCommand,PutCommand,DeleteCommand,QueryCommand} from '@aws-sdk/lib-dynamodb';
import {WebsiteError,type HostingConnection,type HostingDomain,type WebsiteHostingTarget,type WebsiteDestinationBinding} from '@ubeeq/core';
import type {OAuthAuthorizationState} from '@ubeeq/integrations';
import type {WebsiteHostingStore,WebsitePublishPlan,WebsitePublishIntent,WebsiteDeploymentAttempt} from '@ubeeq/persistence';
import {DynamoWebsiteStore} from './websites.js';
import type {WebsiteStoredRecord} from './website-records.js';

const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
type Control={pk:string;sk:string;instanceId:string;cellId:string;kind:string;id:string;revision:number;value:Record<string,unknown>};

/** Hosting state shares the same atomic pointer database as website metadata.
 * Control rows are small, installation-owned indexes; payloads remain private. */
export class DynamoWebsiteHostingStore extends DynamoWebsiteStore implements WebsiteHostingStore {
  private key(kind:string,id:string){return {pk:this.records.partition('__hosting_control__',kind),sk:kind==='review'?'review#'+id:'control#'+sha(id)};}
  private async control(kind:string,id:string):Promise<Control|undefined>{
    const key=this.key(kind,id),item=(await this.records.database.client.send(new GetCommand({TableName:this.configuration.tableName,Key:key,ConsistentRead:true}))).Item as Control|undefined;
    if(item&&(item.pk!==key.pk||item.sk!==key.sk||item.kind!==kind||item.id!==id||item.instanceId!==this.configuration.instanceId||item.cellId!==this.configuration.cellId||item.revision!==1))throw new WebsiteError('artifact_unavailable','Hosting control state needs recovery.');return item;
  }
  private async createControl(kind:string,id:string,value:Record<string,unknown>){
    const item:Control={...this.key(kind,id),instanceId:this.configuration.instanceId,cellId:this.configuration.cellId,kind,id,revision:1,value};
    if(Buffer.byteLength(JSON.stringify(item))>200*1024)throw new WebsiteError('invalid_hosting_state','Hosting control state exceeds its bounded record size.');
    await this.records.database.client.send(new PutCommand({TableName:this.configuration.tableName,Item:item,ConditionExpression:'attribute_not_exists(pk)'}));
  }
  private async deleteControl(kind:string,id:string,required=false){await this.records.database.client.send(new DeleteCommand({TableName:this.configuration.tableName,Key:this.key(kind,id),...(required?{ConditionExpression:'attribute_exists(pk)'}:{})}));}
  private guardControl(row:Control){this.records.database.client.checkRevision!(this.configuration.tableName,{pk:row.pk,sk:row.sk},row.revision);}
  readonly hostingOAuthStates={
    create:async(state:OAuthAuthorizationState)=>{if(state.cellId!==this.configuration.cellId)throw new WebsiteError('foreign_reference','OAuth state belongs to another cell.');await this.createControl('oauth',state.id,{state});},
    consume:async(id:string):Promise<OAuthAuthorizationState|undefined>=>{
      try{return await this.atomic(async()=>{const row=await this.control('oauth',id);if(!row||row.value.consumed)return;
        // Retain the nonce after consumption so an old authorization cannot be reissued.
        await this.records.database.client.send(new PutCommand({TableName:this.configuration.tableName,Item:{...row,value:{consumed:true}},ConditionExpression:'attribute_exists(pk) AND attribute_not_exists(#value.#consumed)',ExpressionAttributeNames:{'#value':'value','#consumed':'consumed'}}));
        return row.value.state as OAuthAuthorizationState;
      });}catch(error){if(error instanceof WebsiteError&&error.code==='revision_conflict')return;throw error;}
    }
  };
  getBinding(w:string,id:string){return this.read<WebsiteDestinationBinding>(w,'website_binding',id);}
  async saveBinding(value:WebsiteDestinationBinding,expected:number){await this.atomic(async()=>{const old=await this.getBinding(value.workspaceId,value.id);if(old&&old.websiteId!==value.websiteId)throw new WebsiteError('foreign_reference','Binding cannot move between websites.');await this.save(value.workspaceId,'website_binding',value,expected);});}
  async listBindings(w:string,site:string){return (await this.list<WebsiteDestinationBinding>(w,'website_binding')).filter(value=>value.websiteId===site);}
  getConnection(w:string,id:string){return this.read<HostingConnection>(w,'hosting_connection',id);}
  listConnections(w:string){return this.list<HostingConnection>(w,'hosting_connection');}
  async saveConnection(value:HostingConnection,expected:number){await this.atomic(async()=>{const old=await this.getConnection(value.workspaceId,value.id);if(old&&(old.accountId!==value.accountId||old.family!==value.family))throw new WebsiteError('account_changed','A different provider account requires a new connection.');await this.save(value.workspaceId,'hosting_connection',value,expected);});}
  getTarget(w:string,id:string){return this.read<WebsiteHostingTarget>(w,'hosting_target',id);}
  async listTargets(w:string,site:string){return (await this.list<WebsiteHostingTarget>(w,'hosting_target')).filter(value=>value.websiteId===site);}
  async setServingState(w:string,id:string,state:WebsiteHostingTarget['serving'],operatorRequired=false){await this.atomic(async()=>{const row=await this.records.get<WebsiteHostingTarget>(w,'hosting_target',id);if(!row)throw new WebsiteError('target_not_found','Target was not found.');await this.records.put(w,'hosting_target',id,{...row.value,serving:state,servingRemovalRequired:operatorRequired},row.stamp);});}
  async saveTarget(value:WebsiteHostingTarget,expected:number){await this.atomic(async()=>{
    const previous=await this.records.get<WebsiteHostingTarget>(value.workspaceId,'hosting_target',value.id),old=previous?.value,rootId=JSON.stringify([value.family,value.accountId,value.remoteId]),root=await this.control('root',rootId);
    if(root&&(root.value.workspaceId!==value.workspaceId||root.value.targetId!==value.id))throw new WebsiteError('hosting_root_in_use','This remote site or root is already managed by another destination.');
    if(root)this.guardControl(root);else await this.createControl('root',rootId,{workspaceId:value.workspaceId,targetId:value.id});
    if(old&&(old.websiteId!==value.websiteId||old.accountId!==value.accountId||old.remoteId!==value.remoteId||old.connectionId!==value.connectionId||old.adapterId!==value.adapterId))throw new WebsiteError('target_identity_changed','Create a new target for another account, root or remote site.');
    if(value.revision!==expected+1||(old?old.revision!==expected:expected!==0))throw new WebsiteError('revision_conflict','Hosting target changed.');
    await this.records.put(value.workspaceId,'hosting_target',value.id,old?{...value,desiredGeneration:old.desiredGeneration,activeGeneration:old.activeGeneration,activeAttemptId:old.activeAttemptId,activeReleaseId:old.activeReleaseId,activeArtifactDigest:old.activeArtifactDigest,serving:old.serving,servingRemovalRequired:old.servingRemovalRequired,lock:old.lock}:value,previous?.stamp);
  });}
  private expiryId(plan:WebsitePublishPlan){return new Date(plan.expiresAt).toISOString()+'#'+sha(JSON.stringify([plan.workspaceId,plan.id]));}
  async putPlan(plan:WebsitePublishPlan,snapshot:unknown){
    const bodies=new Map<string,Uint8Array>();
    const encoded=JSON.stringify(snapshot,function(key,value){const source=key===''?snapshot:this[key];if(source instanceof Uint8Array){const body=Uint8Array.from(source),checksum=sha(body);bodies.set(checksum,body);return {__websiteBlob:checksum};}return value;});
    const expiresAt=new Date(plan.expiresAt).toISOString();
    await this.atomic(async()=>{if(await this.getPlan(plan.workspaceId,plan.id))throw new WebsiteError('revision_conflict','Record already exists.');
      for(const [checksum,body]of bodies)await this.blobs.put(plan.workspaceId,checksum,body);
      await this.save(plan.workspaceId,'publish_plan',{...plan,revision:1},0);
      await this.records.put(plan.workspaceId,'publish_snapshot',plan.snapshotReference,{encoded});
      await this.createControl('review',this.expiryId(plan),{workspaceId:plan.workspaceId,planId:plan.id,expiresAt});
    });
  }
  getPlan(w:string,id:string){return this.read<WebsitePublishPlan>(w,'publish_plan',id);}
  async getSnapshot(w:string,id:string){
    const row=await this.read<{encoded:string}>(w,'publish_snapshot',id);if(!row)return;
    const hydrate=async(value:unknown):Promise<unknown>=>{if(!value||typeof value!=='object')return value;const object=value as Record<string,unknown>;
      if(Object.keys(object).length===1){if(typeof object.__websiteBytes==='string')return new Uint8Array(Buffer.from(object.__websiteBytes,'base64'));if(typeof object.__websiteBlob==='string'){const body=await this.blobs.get(w,object.__websiteBlob);if(!body||sha(body)!==object.__websiteBlob)throw new WebsiteError('snapshot_unavailable','Pinned website media is missing or corrupt.');return body;}}
      if(Array.isArray(value)){const result=[];for(const entry of value)result.push(await hydrate(entry));return result;}const entries=[];for(const [key,entry]of Object.entries(object))entries.push([key,await hydrate(entry)]);return Object.fromEntries(entries);
    };return hydrate(JSON.parse(row.encoded));
  }
  private async controls(kind:string,limit:number,before?:string):Promise<Control[]>{
    const result=await this.records.database.client.send(new QueryCommand({TableName:this.configuration.tableName,KeyConditionExpression:before?'pk = :pk AND sk <= :before':'pk = :pk',ExpressionAttributeValues:{':pk':this.records.partition('__hosting_control__',kind),...(before?{':before':'review#'+new Date(before).toISOString()+'#~'}:{})},ConsistentRead:true,Limit:Math.max(1,Math.min(limit,100))}));
    const rows:Control[]=[];for(const item of result.Items??[]){const checked=await this.control(kind,item.id);if(checked)rows.push(checked);}return rows;
  }
  async cleanupUnacceptedPlans(now:string,limit:number){
    if(!Number.isFinite(Date.parse(now)))throw new WebsiteError('invalid_retention','Cleanup needs an exact timestamp.');let removed=0;
    for(const candidate of await this.controls('review',limit,now)){if(Date.parse(String(candidate.value.expiresAt))>Date.parse(now))continue;
      await this.atomic(async()=>{const row=await this.control('review',candidate.id);if(!row)return;const workspace=String(row.value.workspaceId),id=String(row.value.planId),plan=await this.records.get<WebsitePublishPlan>(workspace,'publish_plan',id);
        if(plan&&Date.parse(plan.value.expiresAt)>Date.parse(now))return;
        // Acceptance deletes this index in its target/intent transaction.
        await this.records.database.client.send(new DeleteCommand({TableName:this.configuration.tableName,Key:{pk:row.pk,sk:row.sk},ConditionExpression:'attribute_exists(pk)'}));
        if(plan){const snapshot=await this.records.get(workspace,'publish_snapshot',plan.value.snapshotReference);if(snapshot)await this.records.remove(snapshot.stamp);await this.records.remove(plan.stamp);}removed++;
      });
    }return removed;
  }
  getIntent(w:string,id:string){return this.read<WebsitePublishIntent>(w,'publish_intent',id);}
  getAttempt(w:string,id:string){return this.read<WebsiteDeploymentAttempt>(w,'hosting_attempt',id);}
  async listAttempts(w:string,site:string){const targets=new Set((await this.listTargets(w,site)).map(value=>value.id));return (await this.list<WebsiteDeploymentAttempt>(w,'hosting_attempt')).filter(value=>targets.has(value.targetId));}
  async acceptIntent(input:Parameters<WebsiteHostingStore['acceptIntent']>[0]){return this.atomic(async()=>{
    const {intent}=input,existing=await this.getIntent(intent.workspaceId,intent.id);if(existing){if(existing.approvalFingerprint!==intent.approvalFingerprint||JSON.stringify(existing.attemptIds)!==JSON.stringify(intent.attemptIds))throw new WebsiteError('idempotency_conflict','Publish key is bound to another approval.');return existing;}
    if(!input.targets.length||input.targets.length>20||new Set(input.targets.map(value=>value.id)).size!==input.targets.length||input.attempts.length!==input.targets.length||new Set(input.attempts.map(value=>value.id)).size!==input.attempts.length||JSON.stringify(intent.attemptIds)!==JSON.stringify(input.attempts.map(value=>value.id)))throw new WebsiteError('invalid_targets','Choose 1–20 distinct publishing targets.');
    if(input.plan){const saved=await this.records.get<WebsitePublishPlan>(intent.workspaceId,'publish_plan',input.plan.id);if(!saved||saved.value.fingerprint!==intent.approvalFingerprint||saved.value.actorId!==intent.actorId||saved.value.websiteId!==intent.websiteId||saved.value.id!==intent.planId||saved.value.snapshotReference!==intent.snapshotReference||Date.parse(saved.value.expiresAt)<=Date.parse(intent.createdAt))throw new WebsiteError('invalid_approval','Publish approval does not match the captured plan.');this.records.guard(saved.stamp);
      if(input.plan.binding){const binding=await this.records.get<WebsiteDestinationBinding>(intent.workspaceId,'website_binding',input.plan.binding.id);if(!binding?.value.enabled||binding.value.revision!==input.plan.binding.revision)throw new WebsiteError('binding_changed','Publishing binding changed after review.');this.records.guard(binding.stamp);}
      const review=await this.control('review',this.expiryId(input.plan));if(!review)throw new WebsiteError('invalid_approval','Publish review is no longer available.');await this.deleteControl('review',review.id,true);
    }
    const guarded=new Set<string>();
    for(const expected of input.targets){const row=await this.records.get<WebsiteHostingTarget>(intent.workspaceId,'hosting_target',expected.id),target=row?.value;
      if(!row||!target||target.revision!==expected.revision||target.desiredGeneration!==expected.desiredGeneration)throw new WebsiteError('revision_conflict','Target configuration or desired generation changed.');
      const attempt=input.attempts.find(value=>value.targetId===target.id);if(!attempt||attempt.workspaceId!==intent.workspaceId||attempt.intentId!==intent.id||attempt.targetRevision!==target.revision||attempt.accountId!==target.accountId||target.websiteId!==intent.websiteId||attempt.generation!==target.desiredGeneration+1)throw new WebsiteError('generation_conflict','Invalid target generation.');
      if(target.connectionId){const connection=await this.records.get<HostingConnection>(intent.workspaceId,'hosting_connection',target.connectionId);if(!connection||connection.value.state!=='connected'||connection.value.accountId!==attempt.accountId||connection.value.revision!==attempt.connectionRevision)throw new WebsiteError('reconnect_required','Connection changed before publication acceptance.');if(!guarded.has(connection.stamp.sk)){this.records.guard(connection.stamp);guarded.add(connection.stamp.sk);}}
      await this.records.put(intent.workspaceId,'hosting_target',target.id,{...target,desiredGeneration:attempt.generation},row.stamp);
      await this.save(intent.workspaceId,'hosting_attempt',attempt,0);
      await this.createControl('outbox',JSON.stringify([intent.workspaceId,attempt.id]),{workspaceId:intent.workspaceId,attemptId:attempt.id});
    }
    await this.save(intent.workspaceId,'publish_intent',{...intent,revision:1},0);return intent;
  });}
  async pendingOutbox(limit:number){return (await this.controls('outbox',limit)).map(row=>({workspaceId:String(row.value.workspaceId),attemptId:String(row.value.attemptId)}));}
  async acknowledgeOutbox(w:string,id:string){await this.deleteControl('outbox',JSON.stringify([w,id]));}
  async claim(w:string,targetId:string,attemptId:string,executionId:string){return this.atomic(async()=>{
    const target=await this.records.get<WebsiteHostingTarget>(w,'hosting_target',targetId),attempt=await this.records.get<WebsiteDeploymentAttempt>(w,'hosting_attempt',attemptId);if(!target||!attempt||attempt.value.targetId!==targetId||['published','unpublished','failed','reconnect_required','superseded','cancelled'].includes(attempt.value.state)||target.value.lock&&target.value.lock.attemptId!==attemptId||target.value.lock&&attempt.value.activationStarted)return false;
    await this.records.put(w,'hosting_target',targetId,{...target.value,lock:{attemptId,executionId}},target.stamp);await this.save(w,'hosting_attempt',{...attempt.value,executionId,revision:attempt.value.revision+1},attempt.value.revision);return true;
  });}
  private async owned(w:string,targetId:string,attemptId:string,executionId:string):Promise<WebsiteStoredRecord<WebsiteHostingTarget>>{const target=await this.records.get<WebsiteHostingTarget>(w,'hosting_target',targetId);if(!target||target.value.lock?.attemptId!==attemptId||target.value.lock.executionId!==executionId)throw new WebsiteError('writer_fenced','A different execution owns this target.');return target;}
  async assertOwner(w:string,t:string,a:string,e:string){return (await this.owned(w,t,a,e)).value;}
  async updateAttempt(value:WebsiteDeploymentAttempt,expected:number,executionId:string){await this.atomic(async()=>{const target=await this.owned(value.workspaceId,value.targetId,value.id,executionId);this.records.guard(target.stamp);await this.save(value.workspaceId,'hosting_attempt',value,expected);});}
  async finish(value:WebsiteDeploymentAttempt,expected:number,executionId:string,outcome?:{releaseId:string;disabled:boolean}){await this.atomic(async()=>{
    const row=await this.owned(value.workspaceId,value.targetId,value.id,executionId),target=row.value;await this.save(value.workspaceId,'hosting_attempt',value,expected);
    const active=outcome&&value.generation>=target.activeGeneration?{servingRemovalRequired:outcome.disabled?false:!!target.servingRemovalRequired,activeGeneration:value.generation,activeAttemptId:value.id,activeReleaseId:outcome.releaseId,activeArtifactDigest:value.artifactDigest,serving:outcome.disabled?'unpublished' as const:target.serving==='suspended'?'suspended' as const:'active' as const}:{};
    await this.records.put(value.workspaceId,'hosting_target',value.targetId,{...target,...active,lock:value.state==='unknown'?target.lock:undefined},row.stamp);await this.deleteControl('outbox',JSON.stringify([value.workspaceId,value.id]));
  });}
  saveDomain(value:HostingDomain,expected:number){return this.atomic(()=>this.save(value.workspaceId,'hosting_domain',value,expected));}
  async listDomains(w:string,targetId:string){return (await this.list<HostingDomain>(w,'hosting_domain')).filter(value=>value.targetId===targetId);}
}
