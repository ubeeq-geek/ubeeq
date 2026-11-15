import {randomUUID} from 'node:crypto';
import {GetCommand,ScanCommand,type TransactWriteCommandInput} from '@aws-sdk/lib-dynamodb';
import {OptimisticConcurrencyError,type Page,type PageRequest,type PersistenceTransaction,type RepositorySnapshot} from '@ubeeq/persistence';
import type {AwsCommandClient} from './client-port.js';

export type RepositoryFence = {table:string;repository:string;expected?:string;changed:boolean;rows?:Map<string,Record<string,any>>};
export interface SnapshotTransactionState {
  id:string;active:boolean;failed:boolean;fences:Map<string,RepositoryFence>;overlay:Map<string,Record<string,any>|undefined>;
}
const identity=(table:string,repository:string)=>JSON.stringify([table,repository]);
const fenceKey=(repository:string)=>({pk:'__ubeeq_repository_snapshot#'+repository,sk:'fence'});
const conflict=(repository:string)=>new OptimisticConcurrencyError('repository:'+repository,0);
const guardedRepositories=new Set(['creators','assets','publications','moderationHolds','hostRecords']);
export const supportsRepositorySnapshots=(repository:string)=>guardedRepositories.has(repository);

/** Complete base-table observations guarded by one mutation marker per repository.
 * No GSI participates. Every SDK repository mutation advances the marker in the
 * same transaction as its data. Legacy rows are read in full, without creating
 * empty history or rewriting IDs. Raw/older writers must be quiesced before use.
 */
export class DynamoRepositorySnapshots {
  constructor(private readonly base:AwsCommandClient,private readonly current:()=>SnapshotTransactionState|undefined){}
  private state(transaction?:PersistenceTransaction):SnapshotTransactionState {
    const state=this.current();
    if(!state?.active||transaction&&state.id!==transaction.id){if(state)state.failed=true;throw Error('Snapshot guards require the active repository transaction.');}
    return state;
  }
  private async version(table:string,repository:string):Promise<string|undefined>{
    const row=(await this.base.send(new GetCommand({TableName:table,Key:fenceKey(repository),ConsistentRead:true}))).Item;
    if(!row)return undefined;
    if(typeof row.version!=='string'||!row.version)throw Error('Repository change marker requires reconciliation.');
    return row.version;
  }
  async capture<T>(table:string,repository:string):Promise<RepositorySnapshot<T>>{
    if(!supportsRepositorySnapshots(repository))throw Error('This repository does not expose guarded inventory snapshots.');
    const active=this.current();if(active){active.failed=true;throw Error('Capture repository snapshots before opening the write transaction.');}
    const expected=await this.version(table,repository),rows=new Map<string,Record<string,any>>();
    let cursor:Record<string,any>|undefined;const seen=new Set<string>();
    do{
      const page=await this.base.send(new ScanCommand({TableName:table,ConsistentRead:true,
        FilterExpression:'#repository = :repository',ExpressionAttributeNames:{'#repository':'repository'},ExpressionAttributeValues:{':repository':repository},ExclusiveStartKey:cursor}));
      for(const row of page.Items??[]){
        if(row.repository!==repository||typeof row.id!=='string'||!row.id||row.pk!==repository+'#'+row.id||row.sk!=='record'
          ||!row.value||row.value.id!==row.id||!Number.isSafeInteger(row.revision)||row.revision<1||row.value.revision!==row.revision||rows.has(row.id))throw Error('Canonical repository inventory requires reconciliation.');
        rows.set(row.id,structuredClone(row));
      }
      cursor=page.LastEvaluatedKey;
      if(cursor){const key=JSON.stringify(cursor);if(seen.has(key))throw Error('Repository inventory repeated a pagination cursor.');seen.add(key);}
    }while(cursor);
    if(await this.version(table,repository)!==expected)throw conflict(repository);
    // The returned payloads cannot modify the private inventory used by list().
    return {items:[...rows.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(row=>structuredClone(row.value) as T),bind:async transaction=>{
      const state=this.state(transaction),key=identity(table,repository),old=state.fences.get(key);
      if(old&&old.expected!==expected){state.failed=true;throw conflict(repository);}
      if(old?.rows){
        if(JSON.stringify([...old.rows].sort(([a],[b])=>a<b?-1:a>b?1:0))!==JSON.stringify([...rows].sort(([a],[b])=>a<b?-1:a>b?1:0))){state.failed=true;throw conflict(repository);}
      }else if(old)old.rows=rows;
      else state.fences.set(key,{table,repository,expected,changed:false,rows});
    }};
  }
  async changed(table:string,repository:string):Promise<void>{
    if(!supportsRepositorySnapshots(repository))throw Error('This repository does not expose guarded inventory snapshots.');
    const state=this.state(),key=identity(table,repository);
    let fence=state.fences.get(key);
    if(!fence){fence={table,repository,expected:await this.version(table,repository),changed:false};state.fences.set(key,fence);}
    fence.changed=true;
  }
  list<T>(table:string,repository:string,request:PageRequest):Page<T>|undefined{
    const state=this.current();if(!state)return undefined;
    this.state();const captured=state.fences.get(identity(table,repository))?.rows;if(!captured)return undefined;
    if(!Number.isSafeInteger(request.limit)||request.limit<1){state.failed=true;throw Error('Invalid snapshot page size.');}
    const rows=new Map(captured);
    for(const [key,row] of state.overlay){
      const [changedTable,pk,sk]=JSON.parse(key);
      if(changedTable!==table||sk!=='record'||typeof pk!=='string'||!pk.startsWith(repository+'#'))continue;
      const id=pk.slice(repository.length+1);if(row)rows.set(id,row);else rows.delete(id);
    }
    const after=request.cursor?Buffer.from(request.cursor,'base64url').toString('utf8'):'';
    const ordered=[...rows.values()].filter(row=>row.id>after).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),limit=Math.min(request.limit,100),selected=ordered.slice(0,limit);
    return {items:selected.map(row=>structuredClone(row.value) as T),...(ordered.length>limit?{nextCursor:Buffer.from(selected.at(-1)!.id).toString('base64url')}:{})};
  }
  writes(state:SnapshotTransactionState):NonNullable<TransactWriteCommandInput['TransactItems']>{
    return [...state.fences.values()].map(fence=>{
      const condition=fence.expected===undefined?{ConditionExpression:'attribute_not_exists(pk)'}:{ConditionExpression:'#version = :version',ExpressionAttributeNames:{'#version':'version'},ExpressionAttributeValues:{':version':fence.expected}};
      return fence.changed?{Put:{TableName:fence.table,Item:{...fenceKey(fence.repository),version:randomUUID()},...condition}}:{ConditionCheck:{TableName:fence.table,Key:fenceKey(fence.repository),...condition}};
    });
  }
  failedFence(state:SnapshotTransactionState,table:string|undefined,key:Record<string,any>|undefined):RepositoryFence|undefined{
    return [...state.fences.values()].find(fence=>fence.table===table&&key?.pk===fenceKey(fence.repository).pk&&key?.sk==='fence');
  }
}
