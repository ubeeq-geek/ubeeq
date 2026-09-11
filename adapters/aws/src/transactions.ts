import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand, type TransactWriteCommandInput, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { PersistenceTransaction } from '@ubeeq/persistence';
import { OptimisticConcurrencyError } from '@ubeeq/persistence';

type Dynamo = Pick<DynamoDBDocumentClient, 'send'> & { assertTransaction?: (transaction: PersistenceTransaction) => void; failTransaction?: () => void };
type State = { id: string; active: boolean; failed: boolean; writes: NonNullable<TransactWriteCommandInput['TransactItems']>; overlay: Map<string, Record<string, any> | undefined> };
const keyOf = (table: string | undefined, key: Record<string, any>) => JSON.stringify([table, key.pk, key.sk]);

/** Atomic repository write batches. Reads are not a serializable snapshot. */
export const createTransactionalDynamo = (base: Dynamo) => {
  const context = new AsyncLocalStorage<State>();
  const client: Dynamo = { failTransaction: () => {
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
    const state: State = { id: randomUUID(), active: true, failed: false, writes: [], overlay: new Map() };
    try {
      return await context.run(state, async () => {
        const result = await operation({ id: state.id });
        if (state.failed) throw new Error('DynamoDB transaction aborted after a failed operation.');
        // Close staging before sending: detached callbacks cannot modify an in-flight batch.
        state.active = false;
        if (state.writes.length) {
          try { await base.send(new TransactWriteCommand({ TransactItems: state.writes, ClientRequestToken: state.id })); }
          catch (error) {
            const failure = error as { name?: string; CancellationReasons?: { Code?: string }[] };
            const reasons = failure.CancellationReasons;
            if (failure.name === 'TransactionCanceledException' && reasons?.length === state.writes.length &&
              reasons.every(reason => reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed')) {
              const index = reasons.findIndex((reason, position) => reason.Code === 'ConditionalCheckFailed' &&
                typeof (state.writes[position].Put || state.writes[position].Delete)?.ExpressionAttributeValues?.[':revision'] === 'number');
              if (index >= 0) {
                const write = state.writes[index];
                const key = write.Put?.Item?.pk || write.Delete?.Key?.pk;
                const revision = (write.Put || write.Delete)!.ExpressionAttributeValues![':revision'];
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
