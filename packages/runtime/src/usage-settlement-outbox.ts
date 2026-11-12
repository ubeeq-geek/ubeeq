import { createHash } from 'node:crypto';
import { repositoryItems, type AssetRecord, type CellOwnedRecord, type HostRecord, type PersistenceTransaction, type UbeeqRepositories } from '@ubeeq/persistence';
import type { UsageQuotaPort, UsageSettlementInput, UsageQuotaReservationInput } from '@ubeeq/extension-sdk';
import type { DurableJob, JobQueue } from '@ubeeq/jobs';

const namespace = 'runtime-usage-settlement';
const fingerprint = (input: UsageSettlementInput) => JSON.stringify([input.creatorId, input.operation, input.idempotencyKey, input.processingCreditsUsed ?? 0, input.storageBytesDelta ?? 0, input.deliveryBytesDelta ?? 0]);
interface Intent { input: UsageSettlementInput; fingerprint: string; state: 'pending' | 'settled'; }
interface ReservationIntent { input: UsageQuotaReservationInput; assetId: string; objectVersion: string; jobId: string; leaseExpiresAt?: string; state: 'pending' | 'recorded'; }
const reservationNamespace = 'runtime-processing-reservation';
/** The effect and settlement intent commit together; delivery is independently replayable. */
export class UsageSettlementOutbox {
  private readonly records: NonNullable<UbeeqRepositories['hostRecords']>;
  constructor(private readonly repositories: UbeeqRepositories, private readonly quota: UsageQuotaPort, private readonly instanceId: string, private readonly cellId: string) {
    if (!repositories.hostRecords) throw new Error('Durable usage settlement requires host records.');
    this.records = repositories.hostRecords;
  }
  private id(input: UsageSettlementInput) { return createHash('sha256').update(JSON.stringify([this.instanceId, namespace, input.creatorId, input.idempotencyKey])).digest('hex'); }
  private reservationId(creatorId: string, key: string) { return createHash('sha256').update(JSON.stringify([this.instanceId, reservationNamespace, creatorId, key])).digest('hex'); }
  async trackReservation(input: UsageQuotaReservationInput & { idempotencyKey: string }, asset: AssetRecord, job: DurableJob): Promise<void> {
    if (asset.homeCellId !== this.cellId || job.cellId !== this.cellId || asset.instanceId !== this.instanceId || input.creatorId !== asset.creatorId) throw new Error('Foreign processing reservation rejected.');
    const id = this.reservationId(input.creatorId, input.idempotencyKey);
    await this.repositories.transaction(async transaction => {
      const row = await this.records.get(id, { transaction }), previous = row?.value as unknown as ReservationIntent | undefined;
      if (previous && (previous.assetId !== asset.id || previous.objectVersion !== asset.objectVersion || previous.jobId !== job.id || JSON.stringify(previous.input) !== JSON.stringify(input))) throw new Error('Processing reservation intent conflicts.');
      const value = { input: { ...input }, assetId: asset.id, objectVersion: asset.objectVersion, jobId: job.id, leaseExpiresAt: job.leaseExpiresAt, state: previous?.state ?? 'pending' };
      if (row) await this.records.update(id, row.revision, { value }, { transaction });
      else await this.records.create({ id, instanceId: this.instanceId, namespace: reservationNamespace, scopeId: input.creatorId, key: input.idempotencyKey, homeCellId: asset.homeCellId, dataHomeRegion: asset.dataHomeRegion, dataHomeAssignedAt: asset.dataHomeAssignedAt, routingRevision: asset.routingRevision, value }, { transaction });
    });
  }
  private async markRecorded(input: UsageSettlementInput, transaction: PersistenceTransaction): Promise<void> {
    const row = await this.records.get(this.reservationId(input.creatorId, input.idempotencyKey), { transaction });
    if (row && row.value.state !== 'recorded') await this.records.update(row.id, row.revision, { value: { ...row.value, state: 'recorded' } }, { transaction });
  }
  async enqueue(input: UsageSettlementInput, home: CellOwnedRecord, transaction: PersistenceTransaction): Promise<HostRecord> {
    if (home.homeCellId !== this.cellId) throw new Error('Foreign-cell usage settlement rejected.');
    const id = this.id(input), existing = await this.records.get(id, { transaction });
    await this.markRecorded(input, transaction);
    if (existing) { this.validate(existing); if ((existing.value as unknown as Intent).fingerprint !== fingerprint(input)) throw new Error('Usage settlement intent conflicts.'); return existing; }
    return this.records.create({ id, instanceId: this.instanceId, namespace, scopeId: input.creatorId, key: input.idempotencyKey, homeCellId: home.homeCellId, dataHomeRegion: home.dataHomeRegion, dataHomeAssignedAt: home.dataHomeAssignedAt, routingRevision: home.routingRevision,
      value: { input: { ...input }, fingerprint: fingerprint(input), state: 'pending' } }, { transaction });
  }
  private validate(record: HostRecord): Intent {
    const intent = record.value as unknown as Intent;
    if (record.instanceId !== this.instanceId || record.homeCellId !== this.cellId || record.namespace !== namespace || !intent?.input || record.id !== this.id(intent.input) || intent.input.creatorId !== record.scopeId || intent.input.idempotencyKey !== record.key || intent.fingerprint !== fingerprint(intent.input) || !['pending','settled'].includes(intent.state)) throw new Error('Invalid usage settlement intent.');
    return intent;
  }
  async deliver(record: HostRecord): Promise<void> {
    const intent = this.validate(record);
    if (intent.state === 'settled') return;
    await this.quota.recordUsageSettlement(intent.input);
    try { await this.records.update(record.id, record.revision, { value: { ...record.value, state: 'settled' } }); }
    catch (error) {
      const current = await this.records.get(record.id);
      if (!current || this.validate(current).state !== 'settled' || (current.value as unknown as Intent).fingerprint !== intent.fingerprint) throw error;
    }
  }
  async drain(limit = 25): Promise<number> {
    let settled = 0;
    for await (const record of repositoryItems(request => this.records.list(request))) {
      if (record.instanceId !== this.instanceId || record.homeCellId !== this.cellId || record.namespace !== namespace || record.value.state !== 'pending') continue;
      await this.deliver(record);
      if (++settled >= limit) break;
    }
    return settled;
  }
  /** Recover expired final leases/cancellations even when the processor never reached its catch block. */
  async recoverTerminal(jobs: JobQueue, limit = 25): Promise<number> {
    let recovered = 0;
    for await (const row of repositoryItems(request => this.records.list(request))) {
      if (row.instanceId !== this.instanceId || row.homeCellId !== this.cellId || row.namespace !== reservationNamespace || row.value.state !== 'pending') continue;
      const intent = row.value as unknown as ReservationIntent;
      if (!intent.input?.idempotencyKey || row.id !== this.reservationId(row.scopeId, intent.input.idempotencyKey) || intent.input.creatorId !== row.scopeId || row.key !== intent.input.idempotencyKey) throw new Error('Invalid processing reservation intent.');
      const job = await jobs.get(intent.jobId);
      if (!job || job.cellId !== this.cellId || !['dead_lettered','cancelled','completed'].includes(job.state) || (job.state === 'cancelled' && intent.leaseExpiresAt && intent.leaseExpiresAt > new Date().toISOString())) continue;
      // Replaying reserve resolves an ambiguous interrupted provider response. No new usage is charged.
      const reservation = await this.quota.checkAndReserveQuota(intent.input);
      await this.repositories.transaction(async transaction => {
        const current = await this.records.get(row.id, { transaction });
        if (!current || current.value.state === 'recorded') return;
        const asset = await this.repositories.assets.get(intent.assetId, { transaction });
        if (!asset || asset.homeCellId !== this.cellId || asset.instanceId !== this.instanceId || asset.objectVersion !== intent.objectVersion) throw new Error('Terminal processing source needs reconciliation.');
        const assetKey = (asset as AssetRecord & { processingUsageKey?: string }).processingUsageKey ?? `asset-processing:${asset.id}:${asset.objectVersion}`;
        if (assetKey !== intent.input.idempotencyKey) throw new Error('Terminal reservation generation needs reconciliation.');
        if (asset.status === 'ready' && !reservation.allowed) throw new Error('Completed processing reservation needs reconciliation.');
        if (asset.status !== 'ready' && asset.status !== 'failed' && asset.status !== 'deleted') await this.repositories.assets.update(asset.id, asset.revision, { status: 'failed' }, { transaction });
        if (reservation.allowed) await this.enqueue({ creatorId: row.scopeId, operation: intent.input.operation, idempotencyKey: intent.input.idempotencyKey!, processingCreditsUsed: asset.status === 'ready' ? 1 : 0 }, asset, transaction);
        else await this.markRecorded({ creatorId: row.scopeId, operation: intent.input.operation, idempotencyKey: intent.input.idempotencyKey! }, transaction);
      });
      if (++recovered >= limit) break;
    }
    return recovered;
  }
}
