import type { AwsCommandClient } from './client-port.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand, type TransactWriteCommandInput, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { PersistenceTransaction, PageRequest, RepositorySnapshot, Page } from '@ubeeq/persistence';
import { OptimisticConcurrencyError } from '@ubeeq/persistence';
import {DynamoRepositorySnapshots,type SnapshotTransactionState} from './repository-snapshots.js';

type Dynamo = AwsCommandClient & { assertTransaction?: (transaction: PersistenceTransaction) => void; failTransaction?: () => void;
  checkRevision?: (table: string, key: Record<string, string>, expectedRevision: number) => void;
  snapshotRepository?<T>(table:string,repository:string):Promise<RepositorySnapshot<T>>;
  snapshotPage?<T>(table:string,repository:string,request:PageRequest):Page<T>|undefined;
  mutateRepository?<T>(table:string,repository:string,operation:()=>Promise<T>):Promise<T> };
type State = SnapshotTransactionState & { writes: NonNullable<TransactWriteCommandInput['TransactItems']> };
const keyOf = (table: string | undefined, key: Record<string, any>) => JSON.stringify([table, key.pk, key.sk]);

/** Atomic repository write batches. Reads are not a serializable snapshot. */
export const createTransactionalDynamo = (base: Dynamo) => {
  const context = new AsyncLocalStorage<State>();
  const snapshots=new DynamoRepositorySnapshots(base,()=>context.getStore());
  const client: Dynamo = {
    snapshotRepository:(table,repository)=>snapshots.capture(table,repository),
    snapshotPage:(table,repository,request)=>snapshots.list(table,repository,request),
    mutateRepository:(table,repository,operation)=>transaction(async()=>{
      const result=await operation();await snapshots.changed(table,repository);return result;
    }),
    checkRevision: (table, key, expectedRevision) => {
    const state = context.getStore();
    if (!state?.active) throw new Error('Revision guards require an active transaction.');
    const identity = keyOf(table, key);
    const existing=state.writes.find(write=>write.ConditionCheck && keyOf(write.ConditionCheck.TableName,write.ConditionCheck.Key!)===identity)?.ConditionCheck;
    if(existing){
      if(existing.ExpressionAttributeValues?.[':revision']===expectedRevision)return;
      state.failed=true;throw new OptimisticConcurrencyError(String(key.pk).slice(String(key.pk).indexOf('#')+1),expectedRevision);
    }
    if (state.overlay.has(identity)) {
      state.failed = true;
      throw new Error('A transaction must guard or write each item once.');
    }
    if (state.writes.length >= 100) { state.failed = true; throw new Error('A repository transaction supports at most 100 distinct writes.'); }
    state.writes.push({ ConditionCheck: { TableName: table, Key: key, ConditionExpression: 'attribute_exists(pk) AND #revision = :revision',
      ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': expectedRevision } } });
  }, failTransaction: () => {
    const state = context.getStore();
    if (state?.active) state.failed = true;
  }, assertTransaction: transaction => {
    const state = context.getStore();
    if (!state?.active || state.id !== transaction.id) {
      if (state) state.failed = true;
      throw new Error('Transaction handle is not active on this repository context.');
    }
  }, send: (async (command: any) => {
    const state = context.getStore();
    if (!state) return base.send(command);
    if (!state.active) throw new Error('DynamoDB transaction context has ended.');
    try {
      if (command instanceof GetCommand) {
        const key = keyOf(command.input.TableName, command.input.Key!);
        if (state.overlay.has(key)) return { Item: structuredClone(state.overlay.get(key)) };
        return await base.send(new GetCommand({ ...command.input, ConsistentRead: true }));
      }
      if (!(command instanceof PutCommand) && !(command instanceof DeleteCommand)) throw new Error('Only point reads and distinct-item Put/Delete writes are supported inside repository transactions.');
      const input = command.input;
      const item = command instanceof PutCommand ? command.input.Item! : undefined;
      const key = keyOf(input.TableName, item || (command as DeleteCommand).input.Key!);
      if (state.writes.some(write => write.ConditionCheck && keyOf(write.ConditionCheck.TableName, write.ConditionCheck.Key!) === key)) throw new Error('A transaction cannot write a guarded item.');
      if (state.overlay.has(key)) throw new Error('A repository transaction cannot write the same item twice.');
      if (state.writes.length >= 100) throw new Error('A repository transaction supports at most 100 distinct writes.');
      const { ReturnValues: _returnValues, ReturnConsumedCapacity: _capacity, ReturnItemCollectionMetrics: _metrics, ...write } = input;
      state.writes.push(command instanceof PutCommand ? { Put: structuredClone(write) as any } : { Delete: structuredClone(write) as any });
      state.overlay.set(key, structuredClone(item));
      return {};
    } catch (error) { state.failed = true; throw error; }
  }) as Dynamo['send'] };
  const transaction = async <T>(operation: (transaction: PersistenceTransaction) => Promise<T>): Promise<T> => {
    const inherited = context.getStore();
    if (inherited) {
      if (!inherited.active) throw new Error('DynamoDB transaction context has ended.');
      try { return await operation({ id: inherited.id }); }
      catch (error) { inherited.failed = true; throw error; }
    }
    const state: State = { id: randomUUID(), active: true, failed: false, writes: [], overlay: new Map(), fences:new Map() };
    try {
      return await context.run(state, async () => {
        const result = await operation({ id: state.id });
        if (state.failed) throw new Error('DynamoDB transaction aborted after a failed operation.');
        const batch=[...state.writes,...snapshots.writes(state)];
        if(batch.length>100)throw Error('A repository transaction supports at most 100 distinct writes, including inventory guards.');
        // Close staging before sending: detached callbacks cannot modify an in-flight batch.
        state.active = false;
        if (batch.length) {
          try { await base.send(new TransactWriteCommand({ TransactItems: batch, ClientRequestToken: state.id })); }
          catch (error) {
            const failure = error as { name?: string; CancellationReasons?: { Code?: string }[] };
            const reasons = failure.CancellationReasons;
            if (failure.name === 'TransactionCanceledException' && reasons?.length === batch.length &&
              reasons.every(reason => reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed')) {
              for(let position=0;position<reasons.length;position++)if(reasons[position].Code==='ConditionalCheckFailed'){
                const write=batch[position],item=write.Put??write.Delete??write.ConditionCheck;
                const key=write.Put?.Item??write.Delete?.Key??write.ConditionCheck?.Key;
                const fence=snapshots.failedFence(state,item?.TableName,key);
                if(fence)throw new OptimisticConcurrencyError('repository:'+fence.repository,0);
              }
              const index = reasons.findIndex((reason, position) => reason.Code === 'ConditionalCheckFailed' &&
                typeof (batch[position].Put || batch[position].Delete || batch[position].ConditionCheck)?.ExpressionAttributeValues?.[':revision'] === 'number');
              if (index >= 0) {
                const write = batch[index];
                const key = write.Put?.Item?.pk || write.Delete?.Key?.pk || write.ConditionCheck?.Key?.pk;
                const revision = (write.Put || write.Delete || write.ConditionCheck)!.ExpressionAttributeValues![':revision'];
                if (typeof key === 'string') throw new OptimisticConcurrencyError(key.slice(key.indexOf('#') + 1), revision);
              }
            }
            throw error;
          }
        }
        return result;
      });
    } finally { state.active = false; }
  };
  return { client, transaction };
};
