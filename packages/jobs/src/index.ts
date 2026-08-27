/** Durable scheduling and queue ports. In-process execution is an adapter choice, not a production default. */
export type JobState = "queued" | "leased" | "completed" | "retry_scheduled" | "dead_lettered" | "cancelled";
export interface DurableJob<TPayload = unknown> { id: string; cellId: string; type: string; payload: TPayload; idempotencyKey: string; state: JobState; attempt: number; maxAttempts: number; availableAt: string; leaseExpiresAt?: string; createdAt: string; updatedAt: string; correlationId?: string; lastError?: { code: string; message: string }; }
export interface JobLease<TPayload = unknown> { job: DurableJob<TPayload>; leaseToken: string; }
export interface JobQueue {
  enqueue<TPayload>(input: Omit<DurableJob<TPayload>, "id" | "state" | "attempt" | "availableAt" | "createdAt" | "updatedAt"> & { availableAt?: string }): Promise<DurableJob<TPayload>>;
  lease<TPayload>(input: { cellId: string; types?: readonly string[]; leaseDurationSeconds: number; workerId: string }): Promise<JobLease<TPayload> | undefined>;
  complete(input: { id: string; leaseToken: string }): Promise<void>;
  retry(input: { id: string; leaseToken: string; error: { code: string; message: string }; retryAt: string }): Promise<void>;
  deadLetter(input: { id: string; leaseToken: string; error: { code: string; message: string } }): Promise<void>;
  cancel(input: { id: string; reason?: string }): Promise<void>;
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
  await queue.retry({ id: created.id, leaseToken: lease.leaseToken, error: { code: "temporary", message: "retry" }, retryAt: new Date(Date.now() - 1_000).toISOString() });
  if ((await queue.get(created.id))?.state !== "retry_scheduled") throw new Error("Job queue contract violation: retry state was not retained.");
  const recovered = await queue.recover({ id: created.id });
  if (recovered.state !== "queued") throw new Error("Job queue contract violation: recovery must return work to queued state.");
  const finalLease = await queue.lease({ cellId: "contract-cell", types: ["contract"], leaseDurationSeconds: 60, workerId: "contract-worker" });
  if (!finalLease) throw new Error("Job queue contract violation: recovered work is not leasable.");
  await queue.complete({ id: created.id, leaseToken: finalLease.leaseToken });
  if ((await queue.get(created.id))?.state !== "completed" || !(await queue.list({ cellId: "contract-cell", states: ["completed"], limit: 10 })).some((job) => job.id === created.id)) throw new Error("Job queue contract violation: completion is not observable.");
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
