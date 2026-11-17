import { AsyncLocalStorage } from 'node:async_hooks';

export type ExternalRequestPriority = 'workflow' | 'interactive' | 'background';

export interface ExternalSyncJob {
  id: string;
  type: string;
  status: 'queued' | 'processing' | 'retry_scheduled' | 'rate_limited' | 'completed' | 'failed';
  nextAttemptAt?: string;
  createdAt: string;
  payload?: Record<string, unknown>;
}

const context = new AsyncLocalStorage<{ priority: ExternalRequestPriority; waiting: Map<string, { at: number; jobs: ExternalSyncJob[] }> }>();

export const isInteractiveExternalJob = (job: Pick<ExternalSyncJob, 'type'> & { payload?: Record<string, unknown> }): boolean =>
  ['collection_import', 'collection_publish'].includes(job.type) && job.payload?.requestPriority === 'background'
    ? false
    : job.payload?.requestPriority === 'interactive' ||
      typeof job.payload?.requestedByUserId === 'string' ||
      ['publish', 'gallery_presentation', 'gallery_order', 'remote_update', 'remote_delete', 'user_action', 'youtube_upload'].includes(job.type);

export const isWorkflowExternalJob = (job: Pick<ExternalSyncJob, 'type'> & { payload?: Record<string, unknown> }): boolean =>
  job.type === 'gallery_sync' && isInteractiveExternalJob(job);

export const externalJobPriority = (job: ExternalSyncJob): number =>
  isWorkflowExternalJob(job) ? 2 : isInteractiveExternalJob(job) ? 1 : 0;

export const externalRequestPriority = (): ExternalRequestPriority =>
  context.getStore()?.priority || 'interactive';

export const withExternalRequestPriority = <T>(priority: ExternalRequestPriority, operation: () => T): T =>
  context.run({ priority, waiting: new Map() }, operation);

export const compareExternalJobPriority = (a: ExternalSyncJob, b: ExternalSyncJob): number =>
  externalJobPriority(b) - externalJobPriority(a) ||
  String(a.nextAttemptAt || a.createdAt).localeCompare(String(b.nextAttemptAt || b.createdAt));

export function prioritizeExternalSyncJobs(jobs: ExternalSyncJob[]): ExternalSyncJob[] {
  return [...jobs].sort(compareExternalJobPriority);
}

export function shouldRetryExternalJob(status: string, attemptCount: number, maxAttempts = 3): boolean {
  if (attemptCount >= maxAttempts) return false;
  return ['retry_scheduled', 'rate_limited', 'processing', 'queued'].includes(status);
}
