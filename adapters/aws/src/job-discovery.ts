import type { DurableJob } from '@ubeeq/jobs';

export interface AwsJobDiscoveryIndexes { cellDue: string; cellTypeDue: string }

export const jobCellTypePartition = (cellId: string, type: string): string => JSON.stringify([cellId, type]);

/** Sparse index attributes for queue-owned records. Terminal jobs leave both indexes. */
export const jobDiscoveryAttributes = (job: DurableJob): Record<string, string | number> => {
  if (!['queued', 'retry_scheduled', 'leased'].includes(job.state)) return {};
  const jobDue = Date.parse(job.state === 'leased' ? job.leaseExpiresAt ?? '' : job.availableAt);
  if (!Number.isFinite(jobDue) || typeof job.cellId !== 'string' || !job.cellId.trim() || typeof job.type !== 'string' || !job.type.trim()) {
    throw new Error('Job discovery requires a cell, type and valid due timestamp.');
  }
  const jobCellType = jobCellTypePartition(job.cellId, job.type);
  if (Buffer.byteLength(job.cellId) > 2048 || Buffer.byteLength(jobCellType) > 2048) throw new Error('Job discovery partition exceeds the DynamoDB key budget.');
  return { jobCell: job.cellId, jobCellType, jobDue };
};
