import { GetCommand, UpdateCommand, type GetCommandOutput, type UpdateCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { DurableJob } from '@ubeeq/jobs';
import { jobDiscoveryAttributes } from './job-discovery.js';

/** Privileged per-record repair. Dry-run by default; never called by a runtime. */
export const repairJobIndexAttributes = async (
  client: { send(command: GetCommand | UpdateCommand): Promise<GetCommandOutput & UpdateCommandOutput> },
  input: { tableName: string; cellId: string; jobId: string; expectedRevision: number; apply?: boolean },
): Promise<{ status: 'missing' | 'conflict' | 'unchanged' | 'would_repair' | 'repaired' }> => {
  const { tableName, cellId, jobId, expectedRevision, apply } = input;
  if (typeof tableName !== 'string' || !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName) || typeof cellId !== 'string' || !cellId.trim() || typeof jobId !== 'string' || !jobId.trim() || Buffer.byteLength(`durableJobs#${jobId}`) > 2048 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || (apply !== undefined && typeof apply !== 'boolean')) throw new Error('Invalid explicit job repair target.');
  const Key = { pk: `durableJobs#${jobId}`, sk: 'record' };
  const top = ['pk', 'sk', 'repository', 'id', 'revision', 'jobCell', 'jobCellType', 'jobDue'];
  const nested = ['id', 'revision', 'cellId', 'type', 'state', 'availableAt', 'leaseExpiresAt'];
  const fields = [...top.map(name => [name]), ...nested.map(name => ['value', name])];
  const names = Object.fromEntries([...new Set(fields.flat())].map(name => [`#${name}`, name]));
  const response = await client.send(new GetCommand({ TableName: tableName, Key, ConsistentRead: true,
    ProjectionExpression: fields.map(path => path.map(name => `#${name}`).join('.')).join(', '), ExpressionAttributeNames: names,
  }));
  const item = response.Item;
  if (!item) return { status: 'missing' };
  const job = item.value;
  if (!job || typeof job !== 'object' || Array.isArray(job) || item.pk !== Key.pk || item.sk !== Key.sk || item.repository !== 'durableJobs' || item.id !== jobId || job.id !== jobId || job.cellId !== cellId || !Number.isSafeInteger(item.revision) || item.revision < 1 || job.revision !== item.revision || !['queued', 'retry_scheduled', 'leased', 'completed', 'dead_lettered', 'cancelled'].includes(job.state)) throw new Error('Job repair target is malformed or outside the requested cell.');
  if (item.revision !== expectedRevision) return { status: 'conflict' };
  const expected = jobDiscoveryAttributes(job as DurableJob);
  const attributes = ['jobCell', 'jobCellType', 'jobDue'];
  if (attributes.every(name => Object.hasOwn(item, name) === Object.hasOwn(expected, name) && item[name] === expected[name])) return { status: 'unchanged' };
  if (!apply) return { status: 'would_repair' };
  const values: Record<string, unknown> = {};
  const conditions = fields.map((path, index) => {
    const parent = path.length === 1 ? item : job;
    const name = path.at(-1)!;
    const expression = path.map(part => `#${part}`).join('.');
    if (!Object.hasOwn(parent, name)) return `attribute_not_exists(${expression})`;
    values[`:observed${index}`] = parent[name];
    return `${expression} = :observed${index}`;
  });
  const update = Object.keys(expected).length ? `SET ${attributes.map((name, index) => {
    values[`:new${index}`] = expected[name]; return `#${name} = :new${index}`;
  }).join(', ')}` : `REMOVE ${attributes.map(name => `#${name}`).join(', ')}`;
  try {
    await client.send(new UpdateCommand({ TableName: tableName, Key, UpdateExpression: update,
      ConditionExpression: conditions.join(' AND '), ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    }));
    return { status: 'repaired' };
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return { status: 'conflict' };
    throw error;
  }
};
