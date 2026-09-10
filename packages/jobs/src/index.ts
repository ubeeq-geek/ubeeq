/** Durable scheduling and queue ports. In-process execution is an adapter choice, not a production default. */
export * from "./retry-backoff.js";
export type JobState = "queued" | "leased" | "completed" | "retry_scheduled" | "dead_lettered" | "cancelled";
export class JobRecoveryError extends Error {
  readonly code = 'job_not_recoverable';
  constructor() { super('Only retry-scheduled or dead-lettered jobs can be recovered.'); this.name = 'JobRecoveryError'; }
}
export const requireRecoverableJob = (state: JobState): void => {
  if (state !== 'retry_scheduled' && state !== 'dead_lettered') throw new JobRecoveryError();
};
export interface DurableJob<TPayload = unknown> { id: string; cellId: string; type: string; payload: TPayload; idempotencyKey: string; state: JobState; attempt: number; maxAttempts: number; availableAt: string; leaseExpiresAt?: string; createdAt: string; updatedAt: string; correlationId?: string; lastError?: { code: string; message: string }; }
export interface JobLease<TPayload = unknown> { job: DurableJob<TPayload>; leaseToken: string; }
export interface JobQueue {
  enqueue<TPayload>(input: Omit<DurableJob<TPayload>, "id" | "state" | "attempt" | "availableAt" | "createdAt" | "updatedAt"> & { availableAt?: string }): Promise<DurableJob<TPayload>>;
  lease<TPayload>(input: { cellId: string; types?: readonly string[]; leaseDurationSeconds: number; workerId: string }): Promise<JobLease<TPayload> | undefined>;
  complete(input: { id: string; leaseToken: string }): Promise<void>;
  /** Release a current lease; exhausted attempt budgets dead-letter instead of scheduling another automatic attempt. */
  retry(input: { id: string; leaseToken: string; error: { code: string; message: string }; retryAt: string }): Promise<void>;
  deadLetter(input: { id: string; leaseToken: string; error: { code: string; message: string } }): Promise<void>;
  cancel(input: { id: string; reason?: string }): Promise<void>;
  /** Atomically recover only retry_scheduled/dead_lettered jobs. Never revive cancellation, completion or an active lease. */
  recover(input: { id: string; availableAt?: string }): Promise<DurableJob>;
  get(id: string): Promise<DurableJob | undefined>;
  list(input: { cellId: string; states?: readonly JobState[]; limit: number }): Promise<readonly DurableJob[]>;
}
export interface Scheduler { schedule(input: { cellId: string; type: string; idempotencyKey: string; payload: unknown; runAt: string }): Promise<void>; cancelSchedule(input: { cellId: string; idempotencyKey: string }): Promise<void>; }

/** Executable baseline for every durable queue adapter. */
export const verifyJobQueueContract = async (queue: JobQueue, idempotencyKey = "queue-contract-job"): Promise<void> => {
  const created = await queue.enqueue({ cellId: "contract-cell", type: "contract", payload: { value: 1 }, idempotencyKey, maxAttempts: 3 });
  const repeated = await queue.enqueue({ cellId: "contract-cell", type: "contract", payload: { value: 1 }, idempotencyKey, maxAttempts: 3 });
  if (created.id !== repeated.id) throw new Error("Job queue contract violation: enqueue must retain idempotency keys.");
  const foreign = await queue.enqueue({ cellId: "foreign-cell", type: "contract", payload: { value: 1 }, idempotencyKey, maxAttempts: 3 });
  if (foreign.id === created.id) throw new Error("Job queue contract violation: idempotency keys must be isolated by cell.");
  if ((await queue.list({ cellId: "contract-cell", limit: 10 })).some((job) => job.id === foreign.id)) throw new Error("Job queue contract violation: list exposed another cell's work.");
  const lease = await queue.lease({ cellId: "contract-cell", types: ["contract"], leaseDurationSeconds: 60, workerId: "contract-worker" });
  if (!lease || lease.job.id !== created.id || lease.job.state !== "leased") throw new Error("Job queue contract violation: queued work is not leasable.");
  if (lease.job.attempt !== created.attempt + 1) throw new Error("Job queue contract violation: claiming work must count its attempt.");
  await queue.retry({ id: created.id, leaseToken: lease.leaseToken, error: { code: "temporary", message: "retry" }, retryAt: new Date(Date.now() - 1_000).toISOString() });
  if ((await queue.get(created.id))?.state !== "retry_scheduled") throw new Error("Job queue contract violation: retry state was not retained.");
  if ((await queue.get(created.id))?.attempt !== lease.job.attempt) throw new Error("Job queue contract violation: retry must not count another execution attempt.");
  const recovered = await queue.recover({ id: created.id });
  if (recovered.state !== "queued") throw new Error("Job queue contract violation: recovery must return work to queued state.");
  const finalLease = await queue.lease({ cellId: "contract-cell", types: ["contract"], leaseDurationSeconds: 60, workerId: "contract-worker" });
  if (!finalLease) throw new Error("Job queue contract violation: recovered work is not leasable.");
  await queue.complete({ id: created.id, leaseToken: finalLease.leaseToken });
  if ((await queue.get(created.id))?.state !== "completed" || !(await queue.list({ cellId: "contract-cell", states: ["completed"], limit: 10 })).some((job) => job.id === created.id)) throw new Error("Job queue contract violation: completion is not observable.");
  for (const state of ['completed', 'cancelled'] as const) {
    const target = state === 'completed' ? created : await queue.enqueue({ cellId: 'contract-cell', type: 'contract', payload: {}, idempotencyKey: `${idempotencyKey}:cancelled`, maxAttempts: 3 });
    if (state === 'cancelled') await queue.cancel({ id: target.id });
    let rejected = false;
    try { await queue.recover({ id: target.id }); } catch { rejected = true; }
    if (!rejected || (await queue.get(target.id))?.state !== state) throw new Error(`Job queue contract violation: recovery revived ${state} work.`);
  }
  const bounded = await queue.enqueue({ cellId: 'contract-cell', type: 'contract-budget', payload: {}, idempotencyKey: `${idempotencyKey}:budget`, maxAttempts: 2 });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const claimed = await queue.lease({ cellId: 'contract-cell', types: ['contract-budget'], leaseDurationSeconds: 60, workerId: 'contract-worker' });
    if (!claimed || claimed.job.id !== bounded.id || claimed.job.attempt !== attempt) throw new Error('Job queue contract violation: retry budget did not retain claim count.');
    const error = { code: 'temporary', message: 'bounded failure' };
    await queue.retry({ id: bounded.id, leaseToken: claimed.leaseToken, error, retryAt: new Date(Date.now() - 1_000).toISOString() });
    const stored = await queue.get(bounded.id);
    if (stored?.state !== (attempt === 2 ? 'dead_lettered' : 'retry_scheduled') || stored.attempt !== attempt || stored.lastError?.code !== error.code || stored.leaseExpiresAt) throw new Error('Job queue contract violation: exhausted retries must retain the error and dead-letter without another attempt.');
  }
  if (await queue.lease({ cellId: 'contract-cell', types: ['contract-budget'], leaseDurationSeconds: 60, workerId: 'contract-worker' })) throw new Error('Job queue contract violation: an exhausted job was automatically leased again.');
  // These pairs collide if an adapter identifies a job by colon concatenation.
  const scopedInput = { type: 'contract-scope', payload: {}, maxAttempts: 3 };
  const left = await queue.enqueue({ ...scopedInput, cellId: 'contract:scope', idempotencyKey });
  const right = await queue.enqueue({ ...scopedInput, cellId: 'contract', idempotencyKey: `scope:${idempotencyKey}` });
  if (left.id === right.id || left.cellId !== 'contract:scope' || right.cellId !== 'contract') throw new Error('Job queue contract violation: delimiter-bearing scopes collided.');
  const leftReplay = await queue.enqueue({ ...scopedInput, cellId: 'contract:scope', idempotencyKey });
  const rightReplay = await queue.enqueue({ ...scopedInput, cellId: 'contract', idempotencyKey: `scope:${idempotencyKey}` });
  if (leftReplay.id !== left.id || rightReplay.id !== right.id) throw new Error('Job queue contract violation: scoped retries changed identity.');
  await queue.cancel({ id: left.id });
  if ((await queue.get(left.id))?.state !== 'cancelled' || (await queue.get(right.id))?.state !== 'queued') throw new Error('Job queue contract violation: cancellation crossed identity scopes.');
  const rightLease = await queue.lease({ cellId: 'contract', types: ['contract-scope'], leaseDurationSeconds: 60, workerId: 'contract-worker' });
  if (!rightLease || rightLease.job.id !== right.id) throw new Error('Job queue contract violation: scope-isolated work is not leasable.');
  await queue.complete({ id: right.id, leaseToken: rightLease.leaseToken });
};

export class ForeignCellJobError extends Error {
  constructor(readonly expectedCellId: string, readonly actualCellId: string) {
    super(`Job belongs to cell ${actualCellId}; worker is scoped to ${expectedCellId}`);
    this.name = "ForeignCellJobError";
  }
}

/** Must be called before a worker performs any side effect. */
export const requireLocalJob = (job: Pick<DurableJob, "cellId">, workerCellId: string): void => {
  if (!workerCellId.trim() || job.cellId !== workerCellId) throw new ForeignCellJobError(workerCellId, job.cellId);
};
