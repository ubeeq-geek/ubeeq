import { ScanCommand, type ScanCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { DurableJob } from '@ubeeq/jobs';
import { jobDiscoveryAttributes } from './job-discovery.js';

type Key = { pk: string; sk: string };
export interface JobIndexAuditCursor { tableName: string; key: Key }
export interface JobIndexAuditIssue { key: Key; reason: 'invalid_record' | 'missing_or_mismatched_attributes' }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const key = (value: unknown): Key => {
  if (!object(value) || Object.keys(value).length !== 2 || typeof value.pk !== 'string' || !value.pk || Buffer.byteLength(value.pk) > 2048 || typeof value.sk !== 'string' || !value.sk || Buffer.byteLength(value.sk) > 1024) throw new Error('Invalid job audit continuation key.');
  return { pk: value.pk, sk: value.sk };
};

/** Table-wide operator audit, never used on a request or worker discovery path. */
export const auditJobIndexPage = async (
  client: { send(command: ScanCommand): Promise<ScanCommandOutput> },
  input: { tableName: string; limit?: number; cursor?: JobIndexAuditCursor },
): Promise<{ evaluated: number; jobs: number; matching: number; issues: JobIndexAuditIssue[]; nextCursor?: JobIndexAuditCursor }> => {
  const tableName = input.tableName;
  const limit = input.limit ?? 100;
  if (typeof tableName !== 'string' || !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName)) throw new Error('Job audit requires an explicit table name.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Job audit page limit must be 1 through 100.');
  if (input.cursor && input.cursor.tableName !== tableName) throw new Error('Job audit cursor belongs to another table.');
  const start = input.cursor ? key(input.cursor.key) : undefined;
  const top = ['pk', 'sk', 'repository', 'id', 'revision', 'jobCell', 'jobCellType', 'jobDue'];
  const nested = ['id', 'revision', 'cellId', 'type', 'state', 'availableAt', 'leaseExpiresAt'];
  const names = Object.fromEntries([...new Set([...top, ...nested, 'value'])].map(name => [`#${name}`, name]));
  const response = await client.send(new ScanCommand({ TableName: tableName, Limit: limit, ConsistentRead: true,
    ProjectionExpression: [...top.map(name => `#${name}`), ...nested.map(name => `#value.#${name}`)].join(', '),
    ExpressionAttributeNames: names, ...(start ? { ExclusiveStartKey: start } : {}),
  }));
  if (!Array.isArray(response.Items) || response.Items.length > limit || !Number.isSafeInteger(response.ScannedCount) || response.ScannedCount !== response.Items.length) throw new Error('Invalid job audit page.');
  const issues: JobIndexAuditIssue[] = [];
  let jobs = 0, matching = 0;
  for (const item of response.Items) {
    if (!object(item)) throw new Error('Invalid job audit item.');
    if (item.repository !== 'durableJobs' && !(typeof item.pk === 'string' && item.pk.startsWith('durableJobs#'))) continue;
    jobs++;
    const recordKey = key({ pk: item.pk, sk: item.sk });
    const job = item.value;
    if (!object(job) || typeof job.id !== 'string' || !job.id || item.id !== job.id || item.pk !== `durableJobs#${job.id}` || item.sk !== 'record' || item.repository !== 'durableJobs' || !Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || job.revision !== item.revision || !['queued', 'retry_scheduled', 'leased', 'completed', 'dead_lettered', 'cancelled'].includes(job.state as string)) {
      issues.push({ key: recordKey, reason: 'invalid_record' }); continue;
    }
    let expected: Record<string, string | number>;
    try { expected = jobDiscoveryAttributes(job as unknown as DurableJob); }
    catch { issues.push({ key: recordKey, reason: 'invalid_record' }); continue; }
    if (['jobCell', 'jobCellType', 'jobDue'].some(name => Object.hasOwn(expected, name) !== Object.hasOwn(item, name) || expected[name] !== item[name])) {
      issues.push({ key: recordKey, reason: 'missing_or_mismatched_attributes' });
    } else matching++;
  }
  const last = response.LastEvaluatedKey;
  const next = last && Object.keys(last).length ? key(last) : undefined;
  if (next && start && next.pk === start.pk && next.sk === start.sk) throw new Error('Job audit cursor did not advance.');
  return { evaluated: response.ScannedCount!, jobs, matching, issues, ...(next ? { nextCursor: { tableName, key: next } } : {}) };
};
