import { createHash } from 'node:crypto';
import { LocalSqliteDatabase, LocalSqliteJobQueue } from './index.js';
import { SmugMugError, SmugMugIntegrationService } from '@ubeeq/integrations';

export interface LocalSmugMugInventoryRunnerOptions {
  /** Stable SQL table identifier; changing it does not migrate existing runs. */
  tableName?: string;
  /** Stable job type; changing it does not relabel queued jobs. */
  jobType?: string;
}
interface InventoryRun {
  id: string; userId: string; creatorId: string; connectionId: string; requestId: string;
  page: number; jobId: string; migrationId?: string; imageCount?: number; collectionCount?: number;
}

/** Single-process development runner with an application-supplied source checkpoint. */
export class LocalSmugMugInventoryRunner {
  private readonly tableName: string;
  private readonly jobType: string;
  private readonly jobs: LocalSqliteJobQueue;
  private busy = false;
  constructor(private readonly database: LocalSqliteDatabase, private readonly service: SmugMugIntegrationService,
    private readonly checkpoint: () => void, private readonly cellId: string, options: LocalSmugMugInventoryRunnerOptions = {}) {
    this.tableName = options.tableName ?? 'ubeeq_smugmug_inventory_runs';
    this.jobType = options.jobType ?? 'ubeeq.smugmug.inventory.page';
    if (typeof this.tableName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(this.tableName)) throw new Error('Invalid inventory run table identifier.');
    if (typeof this.jobType !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(this.jobType)) throw new Error('Invalid inventory job type.');
    if (!cellId.trim()) throw new Error('Inventory worker cell is required.');
    this.jobs = new LocalSqliteJobQueue(database);
    database.database.exec(`CREATE TABLE IF NOT EXISTS ${this.tableName} (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`);
  }

  private read(id: string): InventoryRun | undefined {
    const row = this.database.database.prepare(`SELECT payload FROM ${this.tableName} WHERE id = ?`).get(id) as { payload: string } | undefined;
    return row && JSON.parse(row.payload) as InventoryRun;
  }
  private save(run: InventoryRun) {
    this.database.database.prepare(`INSERT INTO ${this.tableName} (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`).run(run.id, JSON.stringify(run));
  }
  private enqueuePage(run: Pick<InventoryRun, 'id' | 'page'>) {
    return this.jobs.enqueueSync({ cellId: this.cellId, type: this.jobType, payload: { runId: run.id }, idempotencyKey: `${run.id}:${run.page}`, maxAttempts: 3 });
  }
  private async owned(id: string, userId: string) {
    const run = this.read(id);
    if (!run || run.userId !== userId) throw new SmugMugError('INVENTORY_RUN_NOT_FOUND', 404);
    const connection = await this.service.inspectConnection(run.connectionId, userId);
    if (connection.creatorId !== run.creatorId) throw new SmugMugError('INVENTORY_RUN_FORBIDDEN', 403);
    return run;
  }
  async inspect(id: string, userId: string) {
    const run = await this.owned(id, userId);
    const job = await this.jobs.get(run.jobId);
    if (!job || job.cellId !== this.cellId || job.type !== this.jobType) throw new SmugMugError('INVENTORY_JOB_MISSING', 409);
    return { id: run.id, connectionId: run.connectionId, requestId: run.requestId, page: run.page,
      state: job.state, attempt: job.attempt, maxAttempts: job.maxAttempts, complete: Boolean(run.migrationId),
      migrationId: run.migrationId, imageCount: run.imageCount, collectionCount: run.collectionCount,
      errorCode: job.lastError?.code };
  }
  async start(connectionId: string, userId: string, requestId: string) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) throw new SmugMugError('INVALID_INVENTORY_REQUEST_ID', 400);
    const connection = await this.service.ownedConnection(connectionId, userId);
    const id = createHash('sha256').update(JSON.stringify([this.cellId, connectionId, userId, requestId])).digest('hex');
    // Never acknowledge work whose source connection/credentials failed to persist.
    this.checkpoint();
    await this.database.transaction(async () => {
      if (this.read(id)) return;
      const job = this.enqueuePage({ id, page: 0 });
      this.save({ id, userId, creatorId: connection.creatorId, connectionId, requestId, page: 0, jobId: job.id });
    });
    return this.inspect(id, userId);
  }
  async recover(id: string, userId: string) {
    const run = await this.owned(id, userId);
    await this.service.ownedConnection(run.connectionId, userId);
    await this.database.transaction(async () => {
      const current = this.read(id)!;
      if (current.jobId !== run.jobId || current.migrationId) throw new SmugMugError('INVENTORY_RUN_NOT_RECOVERABLE', 409);
      try { await this.jobs.recover({ id: current.jobId }); }
      catch (error) { if ((error as { code?: string }).code === 'job_not_recoverable') throw new SmugMugError('INVENTORY_RUN_NOT_RECOVERABLE', 409); throw error; }
    });
    return this.inspect(id, userId);
  }
  async runOne(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const lease = await this.jobs.lease<{ runId: string }>({ cellId: this.cellId, types: [this.jobType], leaseDurationSeconds: 300, workerId: `local-${process.pid}` });
      if (!lease) return false;
      const acknowledgement = { id: lease.job.id, leaseToken: lease.leaseToken };
      const run = typeof lease.job.payload?.runId === 'string' ? this.read(lease.job.payload.runId) : undefined;
      if (!run || run.jobId !== lease.job.id) {
        await this.jobs.deadLetter({ ...acknowledgement, error: { code: 'inventory_job_mismatch', message: 'Inventory job binding is invalid.' } });
        return true;
      }
      try {
        await this.owned(run.id, run.userId);
        const result = await this.service.inventory(run.connectionId, run.userId, run.requestId);
        this.checkpoint();
        await this.database.transaction(async () => {
          const current = this.read(run.id);
          if (!current || current.jobId !== run.jobId) throw new Error('Inventory job binding changed.');
          // Acknowledgement, next-page enqueue and the visible run pointer commit
          // together. An expired lease rolls all three back.
          await this.jobs.complete(acknowledgement);
          if (result.complete) {
            this.save({ ...current, migrationId: result.migration.id, imageCount: result.imageCount, collectionCount: result.collectionCount });
          } else {
            const page = current.page + 1;
            if (!Number.isSafeInteger(page)) throw new Error('Inventory page count exceeded.');
            const next = this.enqueuePage({ id: run.id, page });
            this.save({ ...current, page, jobId: next.id });
          }
        });
      } catch (error) {
        const failure = { code: error instanceof SmugMugError ? error.code : 'inventory_step_failed', message: 'Inventory step failed; inspect connection and retry status.' };
        if (error instanceof SmugMugError && error.status < 500) await this.jobs.deadLetter({ ...acknowledgement, error: failure });
        else await this.jobs.retry({ ...acknowledgement, error: failure, retryAt: new Date(Date.now() + 5_000).toISOString() });
      }
      return true;
    } finally { this.busy = false; }
  }
}
