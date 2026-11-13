import {createHash} from 'node:crypto';
import {repositoryItems,type CellOwnedRecord,type HostRecord,type PersistenceTransaction,type UbeeqRepositories} from '@ubeeq/persistence';
import type {StorageReservationClosure,UsageQuotaPort} from '@ubeeq/extension-sdk';
const namespace='runtime-storage-closure';
const fingerprint=(input:StorageReservationClosure)=>{
  if(!input.creatorId || !input.operation || !input.idempotencyKey || typeof input.proofId!=='string' || !input.proofId.trim() || input.proofId.length>200 || !Number.isSafeInteger(input.reservedBytes) || input.reservedBytes<0 || !Number.isFinite(Date.parse(input.observedAt)) || new Date(input.observedAt).toISOString()!==input.observedAt)throw new Error('Invalid storage closure facts.');
  return JSON.stringify([input.creatorId,input.operation,input.idempotencyKey,input.reservedBytes,input.proofId,input.observedAt]);
};
interface Intent {input:StorageReservationClosure;fingerprint:string;state:'pending'|'closed'}
/** The physical closure proof and this intent commit together. The quota
 * authority independently fences late grants, even after a lost close reply. */
export class StorageClosureOutbox{
  private readonly records:NonNullable<UbeeqRepositories['hostRecords']>;
  constructor(private readonly repositories:UbeeqRepositories,private readonly quota:UsageQuotaPort,private readonly instanceId:string,private readonly cellId:string){
    if(!repositories.hostRecords || !quota.closeStorageReservation)throw new Error('Durable storage reservation closure is required.');
    this.records=repositories.hostRecords;
  }
  private id(input:StorageReservationClosure){return 'storage-close-'+createHash('sha256').update(JSON.stringify([namespace,this.instanceId,input.creatorId,input.idempotencyKey])).digest('hex');}
  private validate(row:HostRecord):Intent{
    const value=row.value as unknown as Intent;
    if(row.namespace!==namespace || row.instanceId!==this.instanceId || row.homeCellId!==this.cellId || !value?.input || row.id!==this.id(value.input) || row.scopeId!==value.input.creatorId || row.key!==value.input.idempotencyKey || value.fingerprint!==fingerprint(value.input) || !['pending','closed'].includes(value.state))throw new Error('Storage closure intent requires reconciliation.');
    return value;
  }
  async enqueue(input:StorageReservationClosure,home:CellOwnedRecord,transaction:PersistenceTransaction):Promise<HostRecord>{
    if(home.homeCellId!==this.cellId)throw new Error('Foreign storage closure rejected.');
    const id=this.id(input),hash=fingerprint(input),saved=await this.records.get(id,{transaction});
    if(saved){if(this.validate(saved).fingerprint!==hash)throw new Error('Storage closure facts conflict.');return saved;}
    return this.records.create({id,instanceId:this.instanceId,namespace,scopeId:input.creatorId,key:input.idempotencyKey,
      homeCellId:home.homeCellId,dataHomeRegion:home.dataHomeRegion,dataHomeAssignedAt:home.dataHomeAssignedAt,routingRevision:home.routingRevision,
      value:{input:{...input},fingerprint:hash,state:'pending'}},{transaction});
  }
  async deliver(row:HostRecord):Promise<void>{
    const intent=this.validate(row);if(intent.state==='closed')return;
    await this.quota.closeStorageReservation!(intent.input);
    try{await this.records.update(row.id,row.revision,{value:{...row.value,state:'closed'}});}
    catch(error){const saved=await this.records.get(row.id);if(!saved || this.validate(saved).state!=='closed' || this.validate(saved).fingerprint!==intent.fingerprint)throw error;}
  }
  async drain(limit=25):Promise<number>{
    let count=0,failure:unknown;
    for await(const row of repositoryItems(request=>this.records.list(request))){
      if(row.namespace!==namespace || row.instanceId!==this.instanceId || row.homeCellId!==this.cellId || row.value.state!=='pending')continue;
      try{await this.deliver(row);}catch(error){failure??=error;}
      if(++count>=limit)break;
    }
    if(failure)throw failure;return count;
  }
}
