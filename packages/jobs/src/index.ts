/** Durable scheduling and queue ports. In-process execution is an adapter choice, not a production default. */
export type JobState = "queued" | "leased" | "completed" | "retry_scheduled" | "dead_lettered" | "cancelled";
export interface DurableJob<TPayload = unknown> { id: string; type: string; payload: TPayload; idempotencyKey: string; state: JobState; attempt: number; maxAttempts: number; availableAt: string; leaseExpiresAt?: string; createdAt: string; updatedAt: string; correlationId?: string; lastError?: { code: string; message: string }; }
export interface JobLease<TPayload = unknown> { job: DurableJob<TPayload>; leaseToken: string; }
export interface JobQueue {
  enqueue<TPayload>(input: Omit<DurableJob<TPayload>, "id" | "state" | "attempt" | "availableAt" | "createdAt" | "updatedAt"> & { availableAt?: string }): Promise<DurableJob<TPayload>>;
  lease<TPayload>(input: { types?: readonly string[]; leaseDurationSeconds: number; workerId: string }): Promise<JobLease<TPayload> | undefined>;
  complete(input: { id: string; leaseToken: string }): Promise<void>;
  retry(input: { id: string; leaseToken: string; error: { code: string; message: string }; retryAt: string }): Promise<void>;
  deadLetter(input: { id: string; leaseToken: string; error: { code: string; message: string } }): Promise<void>;
  cancel(input: { id: string; reason?: string }): Promise<void>;
  recover(input: { id: string; availableAt?: string }): Promise<DurableJob>;
  get(id: string): Promise<DurableJob | undefined>;
  list(input: { states?: readonly JobState[]; limit: number }): Promise<readonly DurableJob[]>;
}
export interface Scheduler { schedule(input: { type: string; idempotencyKey: string; payload: unknown; runAt: string }): Promise<void>; cancelSchedule(idempotencyKey: string): Promise<void>; }
