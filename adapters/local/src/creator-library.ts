import type { CreatorCollectionMembership, CreatorCollectionPort, CreatorCollectionRecord, CreatorWorkPort, CreatorWorkRecord } from "@ubeeq/core";
import { CreatorWorkError, CreatorCollectionError, CreatorAssetError, contentAssetReferences } from "@ubeeq/core";
import { CreatorAssetRegenerationError, snapshotCreatorSquareCrop, type CreatorAssetRegenerationRequest, type CreatorAssetRegenerationReceipt } from '@ubeeq/core';
import type { CreatorPrimaryAssetCommit, CreatorAssetOrderCommit, CreatorAssetDetachmentCommit } from "@ubeeq/core";
import { isPrivateStoredCreatorAsset, type CreatorExistingAssetCommit } from '@ubeeq/core';
import type { CreatorAssetAttachment, CreatorAssetRecord, CreatorAssetProcessingCommit, CreatorAssetProcessingPort } from "@ubeeq/core";
import type { LocalSqliteDatabase } from "./index.js";
import { LocalSqliteJobQueue } from "./index.js";

// Kept inside the mutation statement so concurrent requests cannot both reserve
// the same current/historical slug. Deleted records follow compatibility semantics
// and release their slugs; restoration must acquire the slug again.
const availableSlug = `NOT EXISTS (
  SELECT 1 FROM ubeeq_creator_library AS existing
  WHERE existing.cell_id = ? AND existing.tenant_id = ? AND existing.kind = ?
    AND existing.creator_id = ? AND existing.id <> ?
    AND coalesce(json_extract(existing.payload, '$.status'), '') <> 'deleted'
    AND EXISTS (SELECT 1 FROM json_each(?) AS candidate WHERE
      json_extract(existing.payload, '$.slug') = candidate.value OR EXISTS (
        SELECT 1 FROM json_each(existing.payload, '$.slugHistory') AS history WHERE history.value = candidate.value
      )
    )
)`;

const validCollectionCover = `(? = '' OR EXISTS (
  SELECT 1 FROM ubeeq_creator_library AS cover
  WHERE cover.cell_id = ? AND cover.tenant_id = ? AND cover.kind = 'asset'
    AND cover.creator_id = ? AND cover.id = ?
    AND json_extract(cover.payload, '$.status') <> 'deleted'
    AND json_extract(cover.payload, '$.storage.scope') = 'private'
))`;

const validWorkAssetReferences = `NOT EXISTS (
  SELECT 1 FROM json_each(?) AS ref WHERE NOT EXISTS (
    SELECT 1 FROM ubeeq_creator_library AS asset
    JOIN ubeeq_creator_library AS membership ON membership.cell_id = asset.cell_id
      AND membership.tenant_id = asset.tenant_id AND membership.kind = 'work_assets' AND membership.id = ?
    WHERE asset.cell_id = ? AND asset.tenant_id = ? AND asset.kind = 'asset' AND asset.id = ref.value
      AND asset.creator_id = ? AND json_extract(asset.payload, '$.status') <> 'deleted'
      AND json_extract(asset.payload, '$.storage.scope') = 'private'
      AND EXISTS (SELECT 1 FROM json_each(membership.payload) AS attached
        WHERE json_extract(attached.value, '$.assetId') = asset.id
          AND json_extract(attached.value, '$.workId') = membership.id)
  )
)`;

/** Durable compatibility library; it does not replace the cell-owned repositories. */
export class LocalCreatorLibraryStore<W extends CreatorWorkRecord, C extends CreatorCollectionRecord>
implements CreatorWorkPort<W>, CreatorCollectionPort<C>, CreatorAssetProcessingPort {
  readonly supportsExpectedCollectionOrder = true;
  constructor(private readonly local: LocalSqliteDatabase, private readonly options: { enqueueImageProcessing?: boolean; enqueueVideoProcessing?: boolean; enqueueAudioProcessing?: boolean; allowSquareCrop?: boolean } = {}) {}

  private get<T>(tenantId: string, kind: string, id: string): T | null {
    const row = this.local.database.prepare("SELECT payload FROM ubeeq_creator_library WHERE cell_id = ? AND tenant_id = ? AND kind = ? AND id = ?")
      .get(this.local.configuration.cellId, tenantId, kind, id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as T : null;
  }

  private list<T>(tenantId: string, kind: string, creatorId: string): T[] {
    const rows = this.local.database.prepare("SELECT payload FROM ubeeq_creator_library WHERE cell_id = ? AND tenant_id = ? AND kind = ? AND creator_id = ? ORDER BY id")
      .all(this.local.configuration.cellId, tenantId, kind, creatorId) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as T);
  }

  private slugParameters(kind: string, id: string, record: { tenantId: string; creatorId: string; slug: string; slugHistory?: string[]; status?: string }): string[] {
    return [this.local.configuration.cellId, record.tenantId, kind, record.creatorId, id,
      JSON.stringify(record.status === "deleted" ? [] : [...new Set([record.slug, ...(record.slugHistory || [])])])];
  }

  private slugConflict(kind: string): Error {
    return kind === "work"
      ? new CreatorWorkError("slug_conflict", "Work slug is already in use for this Creator.")
      : new CreatorCollectionError("slug_conflict", "Collection slug is already in use.");
  }

  private create(kind: string, id: string, record: { tenantId: string; creatorId: string; slug: string }): void {
    const result = this.local.database.prepare(`INSERT INTO ubeeq_creator_library (cell_id, tenant_id, kind, id, creator_id, payload)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${availableSlug}`)
      .run(this.local.configuration.cellId, record.tenantId, kind, id, record.creatorId, JSON.stringify(record), ...this.slugParameters(kind, id, record));
    if (result.changes !== 1) throw this.slugConflict(kind);
  }

  async getWork(tenantId: string, workId: string): Promise<W | null> { return this.get(tenantId, "work", workId); }
  async getProcessingAsset(tenantId: string, assetId: string): Promise<CreatorAssetRecord | null> { return this.get(tenantId, "asset", assetId); }
  async enqueueAssetRegeneration(input: CreatorAssetRegenerationRequest): Promise<CreatorAssetRegenerationReceipt> {
    const squareCrop = snapshotCreatorSquareCrop(input.squareCrop);
    const db = this.local.database, cell = this.local.configuration.cellId;
    db.exec('BEGIN IMMEDIATE');
    try {
      if ([input.tenantId, input.creatorId, input.workId, input.assetId, input.sourceVersionId, input.requestId].some(value =>
        typeof value !== 'string' || !value.trim() || value.length > 500) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new CreatorAssetRegenerationError('invalid_request', 'Invalid regeneration request.');
      }
      const work = this.get<W>(input.tenantId, 'work', input.workId);
      const asset = this.get<CreatorAssetRecord>(input.tenantId, 'asset', input.assetId);
      const attachments = this.get<CreatorAssetAttachment[]>(input.tenantId, 'work_assets', input.workId) || [];
      if (!work || work.creatorId !== input.creatorId || work.status === 'deleted' || !asset || asset.creatorId !== input.creatorId ||
        asset.status === 'deleted' || !attachments.some(item => item.assetId === input.assetId && item.workId === input.workId)) {
        throw new CreatorAssetError('not_found', 'Attached processing asset not found.');
      }
      if (work.revision !== input.expectedRevision) throw new CreatorWorkError('revision_conflict', 'Work changed before regeneration.');
      if (asset.storage.scope !== 'private' || asset.storage.versionId !== input.sourceVersionId) throw new CreatorAssetRegenerationError('source_changed', 'Processing source changed.');
      if (squareCrop && (!this.options.allowSquareCrop || !this.options.enqueueImageProcessing || !asset.mimeType.startsWith('image/'))) throw new CreatorAssetRegenerationError('processing_unsupported', 'Square crop processing is not enabled.');
      if (!((this.options.enqueueImageProcessing && asset.mimeType.startsWith('image/')) ||
        (this.options.enqueueVideoProcessing && asset.mimeType.startsWith('video/')) ||
        (this.options.enqueueAudioProcessing && asset.mimeType.startsWith('audio/')))) throw new CreatorAssetRegenerationError('processing_unsupported', 'No enabled processor for this media.');
      const key = JSON.stringify(['creator-asset.regenerate', input.tenantId, input.creatorId, input.workId, input.assetId, input.sourceVersionId, input.requestId]);
      const previous = db.prepare('SELECT id, state, payload FROM ubeeq_jobs WHERE cell_id = ? AND idempotency_key = ?')
        .get(cell, `${cell}:${key}`) as { id: string; state: string; payload: string } | undefined;
      if (previous) {
        if (JSON.stringify(snapshotCreatorSquareCrop(JSON.parse(previous.payload).squareCrop)) !== JSON.stringify(squareCrop)) throw new CreatorAssetRegenerationError('invalid_request', 'Request key already belongs to a different crop.');
        db.exec('COMMIT'); return { jobId: previous.id, state: previous.state, idempotent: true };
      }
      const active = db.prepare(`SELECT id FROM ubeeq_jobs WHERE cell_id = ? AND type = 'creator-asset.process'
        AND state IN ('queued', 'leased', 'retry_scheduled') AND json_extract(payload, '$.tenantId') = ?
        AND json_extract(payload, '$.assetId') = ? LIMIT 1`).get(cell, input.tenantId, input.assetId);
      if (active) throw new CreatorAssetRegenerationError('processing_busy', 'An active job already processes this asset.');
      const job = new LocalSqliteJobQueue(this.local).enqueueSync({ cellId: cell, type: 'creator-asset.process',
        payload: { tenantId: input.tenantId, creatorId: input.creatorId, workId: input.workId, assetId: input.assetId, sourceVersionId: input.sourceVersionId, ...(squareCrop ? { squareCrop } : {}) },
        idempotencyKey: key, maxAttempts: 3 });
      db.prepare("UPDATE ubeeq_creator_library SET payload = ? WHERE cell_id = ? AND tenant_id = ? AND kind = 'asset' AND id = ?")
        .run(JSON.stringify({ ...asset, processingJobId: job.id }), cell, input.tenantId, input.assetId);
      db.exec('COMMIT');
      return { jobId: job.id, state: job.state, idempotent: false };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async commitAssetProcessing(input: CreatorAssetProcessingCommit): Promise<void> {
    const db = this.local.database, cell = this.local.configuration.cellId;
    db.exec("BEGIN IMMEDIATE");
    try {
      const timestamp = new Date().toISOString();
      const job = db.prepare("SELECT payload FROM ubeeq_jobs WHERE id = ? AND cell_id = ? AND type = 'creator-asset.process' AND state = 'leased' AND lease_token = ? AND lease_expires_at > ?")
        .get(input.jobId, cell, input.leaseToken, timestamp) as { payload: string } | undefined;
      if (!job) throw new Error("Processing lease is not current.");
      const payload = JSON.parse(job.payload);
      for (const key of ["tenantId", "creatorId", "workId", "assetId", "sourceVersionId"] as const) {
        if (!input[key] || payload[key] !== input[key]) throw new Error("Processing job scope does not match result.");
      }
      const asset = this.get<CreatorAssetRecord>(input.tenantId, "asset", input.assetId);
      const work = this.get<W>(input.tenantId, "work", input.workId);
      const attachments = this.get<CreatorAssetAttachment[]>(input.tenantId, "work_assets", input.workId) || [];
      if (!asset || asset.creatorId !== input.creatorId || asset.storage.versionId !== input.sourceVersionId || asset.status === "deleted" ||
        (asset.processingJobId !== undefined && asset.processingJobId !== input.jobId) ||
        !work || work.creatorId !== input.creatorId || work.status === "deleted" || !attachments.some((item) => item.assetId === input.assetId)) {
        throw new Error("Processing source or ownership changed.");
      }
      if (!input.renditions.length || new Set(input.renditions.map((item) => item.id)).size !== input.renditions.length) throw new Error("Processing requires uniquely identified renditions.");
      const renditions = input.renditions.map((item) => {
        const object = item.storage;
        if (!item.id || item.sourceVersionId !== input.sourceVersionId || !["preview", "poster"].includes(item.role) ||
          !object || object.scope !== "private" || !object.bucket || !object.key || !object.versionId || !object.contentType ||
          !Number.isSafeInteger(object.byteLength) || object.byteLength <= 0 || !/^[a-f0-9]{64}$/.test(object.checksum)) throw new Error("Invalid stored rendition.");
        // Persist only references, never transient bytes or arbitrary object fields.
        return { id: item.id, sourceVersionId: item.sourceVersionId, role: item.role,
          storage: { bucket: object.bucket, key: object.key, versionId: object.versionId, contentType: object.contentType,
            byteLength: object.byteLength, checksum: object.checksum, scope: "private" as const } };
      });
      if (Object.values(input.metadata).some((value) => !["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value)))) throw new Error("Invalid processing metadata.");
      const next = { ...asset, updatedAt: timestamp, processing: { state: "completed" as const, sourceVersionId: input.sourceVersionId, completedAt: timestamp, metadata: input.metadata, renditions } };
      db.prepare("UPDATE ubeeq_creator_library SET payload = ? WHERE cell_id = ? AND tenant_id = ? AND kind = 'asset' AND id = ?")
        .run(JSON.stringify(next), cell, input.tenantId, input.assetId);
      const completed = db.prepare("UPDATE ubeeq_jobs SET state = 'completed', lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND cell_id = ? AND state = 'leased' AND lease_token = ? AND lease_expires_at > ?")
        .run(timestamp, input.jobId, cell, input.leaseToken, new Date().toISOString());
      if (completed.changes !== 1) throw new Error("Processing lease expired before commit.");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  async listCanonicalAssetsByWork(tenantId: string, workId: string): Promise<Array<CreatorAssetRecord & { attachment: CreatorAssetAttachment }>> {
    const attachments = this.get<CreatorAssetAttachment[]>(tenantId, "work_assets", workId) || [];
    return attachments.map((attachment) => {
      const asset = this.get<CreatorAssetRecord>(tenantId, "asset", attachment.assetId);
      if (!asset) throw new Error("Stored Work attachment has no asset.");
      return { ...asset, attachment };
    });
  }
  /** A custody candidate, not authorization or a reservation. Recheck on attachment. */
  async findReusableAssetByChecksum(tenantId: string, creatorId: string, checksum: string): Promise<{ assetId: string; sourceWorkId: string } | undefined> {
    if (!/^[a-f0-9]{64}$/.test(checksum)) throw new CreatorAssetError('invalid_asset', 'Expected a lowercase SHA-256 checksum.');
    const row = this.local.database.prepare(`
      SELECT asset.id AS assetId, source.id AS sourceWorkId
      FROM ubeeq_creator_library AS asset INDEXED BY ubeeq_creator_asset_checksum
      JOIN ubeeq_creator_asset_memberships AS member
        ON member.cell_id = asset.cell_id AND member.tenant_id = asset.tenant_id AND member.asset_id = asset.id
      JOIN ubeeq_creator_library AS source
        ON source.cell_id = member.cell_id AND source.tenant_id = member.tenant_id AND source.kind = 'work' AND source.id = member.work_id
      WHERE asset.cell_id = ? AND asset.tenant_id = ? AND asset.creator_id = ? AND asset.kind = 'asset'
        AND json_extract(asset.payload, '$.checksumSha256') = ?
        AND json_extract(asset.payload, '$.tenantId') = asset.tenant_id
        AND json_extract(asset.payload, '$.creatorId') = asset.creator_id
        AND json_extract(asset.payload, '$.status') <> 'deleted'
        AND json_extract(asset.payload, '$.storage.scope') = 'private'
        AND json_type(asset.payload, '$.sizeBytes') = 'integer'
        AND json_extract(asset.payload, '$.sizeBytes') BETWEEN 1 AND 9007199254740991
        AND json_extract(asset.payload, '$.storage.byteLength') = json_extract(asset.payload, '$.sizeBytes')
        AND json_extract(asset.payload, '$.storage.checksum') = json_extract(asset.payload, '$.checksumSha256')
        AND length(json_extract(asset.payload, '$.storage.versionId')) > 0
        AND json_extract(asset.payload, '$.processing.state') = 'completed'
        AND json_extract(asset.payload, '$.processing.sourceVersionId') = json_extract(asset.payload, '$.storage.versionId')
        AND source.creator_id = asset.creator_id AND json_extract(source.payload, '$.creatorId') = asset.creator_id
        AND json_extract(source.payload, '$.status') NOT IN ('deleted', 'archived')
      ORDER BY asset.id, source.id LIMIT 1
    `).get(this.local.configuration.cellId, tenantId, creatorId, checksum) as { assetId: string; sourceWorkId: string } | undefined;
    return row ? { ...row } : undefined;
  }
  async commitPrimaryAsset(input: CreatorPrimaryAssetCommit): Promise<W> {
    const db = this.local.database, cell = this.local.configuration.cellId;
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.get<W>(input.tenantId, 'work', input.workId);
      if (!previous || previous.creatorId !== input.creatorId || previous.status === 'deleted' ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || previous.revision !== input.expectedRevision) {
        throw new CreatorWorkError('revision_conflict', 'Work changed before primary selection.');
      }
      const attachments = this.get<CreatorAssetAttachment[]>(input.tenantId, 'work_assets', input.workId) || [];
      const asset = this.get<CreatorAssetRecord>(input.tenantId, 'asset', input.assetId);
      if (!asset || asset.creatorId !== input.creatorId || asset.tenantId !== input.tenantId || asset.status === 'deleted' || asset.storage?.scope !== 'private' ||
        !attachments.some(item => item.workId === input.workId && item.assetId === input.assetId)) {
        throw new CreatorAssetError('invalid_asset', 'Select an attached private asset.');
      }
      const next = { ...previous, primaryAssetId: input.assetId, revision: previous.revision + 1, updatedAt: input.updatedAt };
      const roles = attachments.map(item => ({ ...item, role: item.assetId === input.assetId ? 'primary' : 'content' }));
      db.prepare("UPDATE ubeeq_creator_library SET payload = ? WHERE cell_id = ? AND tenant_id = ? AND kind = 'work_assets' AND id = ?")
        .run(JSON.stringify(roles), cell, input.tenantId, input.workId);
      db.prepare("UPDATE ubeeq_creator_library SET payload = ? WHERE cell_id = ? AND tenant_id = ? AND kind = 'work' AND id = ?")
        .run(JSON.stringify(next), cell, input.tenantId, input.workId);
      db.exec('COMMIT');
      return next;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async commitAssetDetachment(input: CreatorAssetDetachmentCommit): Promise<W> {
    const db = this.local.database, cell = this.local.configuration.cellId;
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.get<W & { body?: unknown; media?: unknown; primaryAssetId?: string }>(input.tenantId, 'work', input.workId);
      if (!previous || previous.creatorId !== input.creatorId || previous.status === 'deleted' ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || previous.revision !== input.expectedRevision) {
        throw new CreatorWorkError('revision_conflict', 'Work changed before asset removal.');
      }
      const attachments = this.get<CreatorAssetAttachment[]>(input.tenantId, 'work_assets', input.workId) || [];
      if (!attachments.some(item => item.workId === input.workId && item.assetId === input.assetId)) throw new CreatorAssetError('not_found', 'Attached asset not found.');
      if (contentAssetReferences(previous.body, previous.media).includes(input.assetId)) {
        throw new CreatorAssetError('asset_in_use', 'Remove this asset from the saved Work content before detaching it.');
      }
      const remaining = attachments.filter(item => item.assetId !== input.assetId).sort((a, b) => a.position - b.position);
      const primaryAssetId = remaining.some(item => item.assetId === previous.primaryAssetId) ? previous.primaryAssetId : remaining[0]?.assetId;
      const next = { ...previous, primaryAssetId, revision: previous.revision + 1, updatedAt: input.updatedAt };
      const ordered = remaining.map((item, position) => ({ ...item, position, role: item.assetId === primaryAssetId ? 'primary' : 'content' }));
      db.prepare("UPDATE ubeeq_creator_library SET payload = ? WHERE cell_id = ? AND tenant_id = ? AND kind = 'work_assets' AND id = ?")
        .run(JSON.stringify(ordered), cell, input.tenantId, input.workId);
      db.prepare("UPDATE ubeeq_creator_library SET payload = ? WHERE cell_id = ? AND tenant_id = ? AND kind = 'work' AND id = ?")
        .run(JSON.stringify(next), cell, input.tenantId, input.workId);
      db.prepare(`UPDATE ubeeq_jobs SET state = 'cancelled', lease_token = NULL, lease_expires_at = NULL, updated_at = ?, last_error = ?
        WHERE cell_id = ? AND type = 'creator-asset.process' AND state IN ('queued', 'leased', 'retry_scheduled')
          AND json_extract(payload, '$.tenantId') = ? AND json_extract(payload, '$.creatorId') = ?
          AND json_extract(payload, '$.workId') = ? AND json_extract(payload, '$.assetId') = ?`)
        .run(input.updatedAt, JSON.stringify({ code: 'asset_detached', message: 'Asset detached from Work; stored files retained.' }), cell, input.tenantId, input.creatorId, input.workId, input.assetId);
      db.exec('COMMIT');
      return next;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async commitAssetOrder(input: CreatorAssetOrderCommit): Promise<W> {
    const db = this.local.database, cell = this.local.configuration.cellId;
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.get<W>(input.tenantId, 'work', input.workId);
      if (!previous || previous.creatorId !== input.creatorId || previous.status === 'deleted' ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || previous.revision !== input.expectedRevision) {
        throw new CreatorWorkError('revision_conflict', 'Work changed before asset ordering.');
      }
      const attachments = this.get<CreatorAssetAttachment[]>(input.tenantId, 'work_assets', input.workId) || [];
      const ids = input.assetIds;
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length || new Set(attachments.map(item => item.assetId)).size !== attachments.length || ids.length !== attachments.length ||
        ids.some(id => typeof id !== 'string' || !id) || attachments.some(item => item.workId !== input.workId || !ids.includes(item.assetId))) {
        throw new CreatorAssetError('invalid_asset', 'Supply every attached asset exactly once.');
      }
      const ordered = ids.map((id, position) => ({ ...attachments.find(item => item.assetId === id)!, position }));
      const next = { ...previous, revision: previous.revision + 1, updatedAt: input.updatedAt };
      db.prepare("UPDATE ubeeq_creator_library SET payload = ? WHERE cell_id = ? AND tenant_id = ? AND kind = 'work_assets' AND id = ?")
        .run(JSON.stringify(ordered), cell, input.tenantId, input.workId);
      db.prepare("UPDATE ubeeq_creator_library SET payload = ? WHERE cell_id = ? AND tenant_id = ? AND kind = 'work' AND id = ?")
        .run(JSON.stringify(next), cell, input.tenantId, input.workId);
      db.exec('COMMIT');
      return next;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async commitAssetAttachment(input: { previousRevision: number; work: W; asset: CreatorAssetRecord; attachment: CreatorAssetAttachment }): Promise<void> {
    const { work, asset, attachment } = input;
    const db = this.local.database, cell = this.local.configuration.cellId;
    // No await inside this synchronous transaction: unrelated requests cannot
    // enter the connection between its statements. Join an owned import transaction.
    this.local.transactionSync(() => {
      const previous = this.get<W>(work.tenantId, "work", work.workId);
      if (!previous || previous.revision !== input.previousRevision || work.revision !== input.previousRevision + 1 ||
        previous.creatorId !== work.creatorId || previous.status === "deleted") {
        throw new CreatorWorkError("revision_conflict", "Work changed before the asset could be attached.");
      }
      const attachments = this.get<CreatorAssetAttachment[]>(work.tenantId, "work_assets", work.workId) || [];
      if (asset.tenantId !== work.tenantId || asset.creatorId !== work.creatorId || attachment.workId !== work.workId ||
        attachment.assetId !== asset.assetId || attachment.position !== (attachments.length ? Math.max(...attachments.map(item => item.position)) + 1 : 0)) throw new Error("Invalid asset attachment scope or position.");
      db.prepare("INSERT INTO ubeeq_creator_library (cell_id, tenant_id, kind, id, creator_id, payload) VALUES (?, ?, 'asset', ?, ?, ?)")
        .run(cell, asset.tenantId, asset.assetId, asset.creatorId, JSON.stringify(asset));
      db.prepare("INSERT INTO ubeeq_creator_library (cell_id, tenant_id, kind, id, creator_id, payload) VALUES (?, ?, 'work_assets', ?, ?, ?) ON CONFLICT(cell_id, tenant_id, kind, id) DO UPDATE SET payload = excluded.payload")
        .run(cell, work.tenantId, work.workId, work.creatorId, JSON.stringify([...attachments, attachment]));
      // This operation edits only media membership, not titles or slug history.
      const next = { ...previous, primaryAssetId: (previous as W & { primaryAssetId?: string }).primaryAssetId || asset.assetId, revision: work.revision, updatedAt: work.updatedAt };
      db.prepare("UPDATE ubeeq_creator_library SET payload = ? WHERE cell_id = ? AND tenant_id = ? AND kind = 'work' AND id = ?")
        .run(JSON.stringify(next), cell, work.tenantId, work.workId);
      if (asset.status === "pending" && ((this.options.enqueueImageProcessing && asset.mimeType.startsWith("image/")) ||
        (this.options.enqueueVideoProcessing && asset.mimeType.startsWith("video/")) ||
        (this.options.enqueueAudioProcessing && asset.mimeType.startsWith("audio/")))) {
        new LocalSqliteJobQueue(this.local).enqueueSync({ cellId: cell, type: "creator-asset.process",
          payload: { tenantId: asset.tenantId, creatorId: asset.creatorId, workId: work.workId, assetId: asset.assetId, sourceVersionId: asset.storage.versionId },
          idempotencyKey: JSON.stringify(["creator-asset.process", asset.tenantId, asset.assetId, asset.storage.versionId]), maxAttempts: 3 });
      }
    });
  }
  async commitExistingAssetAttachment(input: CreatorExistingAssetCommit): Promise<W> {
    return this.local.transactionSync(() => {
      const db = this.local.database, cell = this.local.configuration.cellId;
      const target = this.get<W>(input.tenantId, 'work', input.workId);
      const source = this.get<W>(input.tenantId, 'work', input.sourceWorkId);
      const asset = this.get<CreatorAssetRecord>(input.tenantId, 'asset', input.assetId);
      const sourceMembers = this.get<CreatorAssetAttachment[]>(input.tenantId, 'work_assets', input.sourceWorkId) || [];
      if (!target || !source || target.creatorId !== input.creatorId || source.creatorId !== input.creatorId ||
        [target.status, source.status].some(status => status === 'deleted' || status === 'archived') ||
        !asset || asset.creatorId !== input.creatorId || asset.tenantId !== input.tenantId || asset.status === 'deleted' ||
        !isPrivateStoredCreatorAsset(asset) || asset.checksumSha256 !== input.checksum ||
        asset.processing?.state !== 'completed' || asset.processing.sourceVersionId !== asset.storage.versionId ||
        !sourceMembers.some(member => member.assetId === input.assetId && member.workId === input.sourceWorkId)) {
        throw new CreatorAssetError('invalid_asset', 'Existing asset is not in current processed private custody.');
      }
      if (!Number.isSafeInteger(input.expectedRevision) || target.revision !== input.expectedRevision) {
        throw new CreatorWorkError('revision_conflict', 'Work changed before existing asset attachment.');
      }
      const members = this.get<CreatorAssetAttachment[]>(input.tenantId, 'work_assets', input.workId) || [];
      if (members.some(member => member.assetId === input.assetId)) return target;
      const primaryAssetId = (target as W & { primaryAssetId?: string }).primaryAssetId || input.assetId;
      const member: CreatorAssetAttachment = { workId: input.workId, assetId: input.assetId, position: members.length ? Math.max(...members.map(item => item.position)) + 1 : 0,
        role: primaryAssetId === input.assetId ? 'primary' : 'content' };
      const next = { ...target, primaryAssetId, revision: target.revision + 1, updatedAt: input.updatedAt };
      db.prepare("INSERT INTO ubeeq_creator_library (cell_id, tenant_id, kind, id, creator_id, payload) VALUES (?, ?, 'work_assets', ?, ?, ?) ON CONFLICT(cell_id, tenant_id, kind, id) DO UPDATE SET payload = excluded.payload")
        .run(cell, input.tenantId, input.workId, input.creatorId, JSON.stringify([...members, member]));
      db.prepare("UPDATE ubeeq_creator_library SET payload = ? WHERE cell_id = ? AND tenant_id = ? AND kind = 'work' AND id = ?")
        .run(JSON.stringify(next), cell, input.tenantId, input.workId);
      return next;
    });
  }
  async listWorksByCreator(tenantId: string, creatorId: string, options: { includeDeleted?: boolean } = {}): Promise<W[]> {
    return this.list<W>(tenantId, "work", creatorId).filter((work) => options.includeDeleted === true || work.status !== "deleted").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  private referenceParameters(work: W): string[] {
    const content = work as W & { body?: unknown; media?: unknown };
    return [JSON.stringify(contentAssetReferences(content.body, content.media)), work.workId, this.local.configuration.cellId, work.tenantId, work.creatorId];
  }
  async createWork(work: W): Promise<void> {
    // A newly created Work has no attachments. Upload first, then save references.
    if (this.referenceParameters(work)[0] !== '[]') throw new CreatorAssetError('invalid_asset', 'Create the Work and attach its assets before referencing them.');
    this.create("work", work.workId, work);
  }
  async updateWork(work: W): Promise<void> {
    const references = this.referenceParameters(work);
    const result = this.local.database.prepare(`UPDATE ubeeq_creator_library SET payload = ? WHERE cell_id = ? AND tenant_id = ? AND kind = 'work' AND id = ? AND creator_id = ? AND json_extract(payload, '$.revision') = ? AND ${availableSlug} AND ${validWorkAssetReferences}`)
      .run(JSON.stringify(work), this.local.configuration.cellId, work.tenantId, work.workId, work.creatorId, work.revision - 1, ...this.slugParameters("work", work.workId, work), ...references);
    if (result.changes !== 1) {
      const current = this.get<W>(work.tenantId, "work", work.workId);
      if (!current || current.creatorId !== work.creatorId || current.revision !== work.revision - 1) {
        throw new CreatorWorkError("revision_conflict", "Work revision conflict or record not found.");
      }
      const valid = this.local.database.prepare(`SELECT ${validWorkAssetReferences} AS valid`).get(...references) as { valid: number };
      if (!valid.valid) throw new CreatorAssetError('invalid_asset', 'Content must reference active private assets attached to this Work.');
      throw this.slugConflict("work");
    }
  }
  async commitWorkRevision(work: W, expectedRevision: number): Promise<void> {
    if (work.revision !== expectedRevision + 1) throw new CreatorWorkError("revision_conflict", "Invalid Work revision increment.");
    await this.updateWork(work);
  }
  async getCreatorCollection(tenantId: string, collectionId: string): Promise<C | null> { return this.get(tenantId, "collection", collectionId); }
  async listCreatorCollections(tenantId: string, creatorId: string, options: { includeDeleted?: boolean } = {}): Promise<C[]> {
    return this.list<C & { title?: string }>(tenantId, "collection", creatorId).filter((collection) => options.includeDeleted === true || collection.status !== "deleted")
      .sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  }
  readonly supportsCollectionCoverValidation = true;
  private coverParameters(collection: C): string[] {
    const cover = collection.status === 'deleted' ? '' : collection.coverAssetId || '';
    return [cover, this.local.configuration.cellId, collection.tenantId, collection.creatorId, cover];
  }
  private requireStoredCover(collection: C): void {
    const valid = this.local.database.prepare(`SELECT ${validCollectionCover} AS valid`).get(...this.coverParameters(collection)) as { valid: number };
    if (!valid.valid) throw new CreatorCollectionError('invalid_cover', 'Choose an active private asset owned by this Creator.');
  }
  async createCreatorCollection(collection: C): Promise<void> {
    const result = this.local.database.prepare(`INSERT INTO ubeeq_creator_library (cell_id, tenant_id, kind, id, creator_id, payload)
      SELECT ?, ?, 'collection', ?, ?, ? WHERE ${availableSlug} AND ${validCollectionCover}`)
      .run(this.local.configuration.cellId, collection.tenantId, collection.collectionId, collection.creatorId, JSON.stringify(collection),
        ...this.slugParameters('collection', collection.collectionId, collection), ...this.coverParameters(collection));
    if (result.changes !== 1) { this.requireStoredCover(collection); throw this.slugConflict('collection'); }
  }
  readonly supportsExpectedCollectionStatus = true;
  readonly supportsExpectedCollectionRevision = true;
  async updateCreatorCollection(collection: C, expectedStatus?: string, expectedRevision?: number): Promise<void> {
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER)) throw new CreatorCollectionError('revision_conflict', 'Invalid collection revision.');
    const result = this.local.database.prepare(`UPDATE ubeeq_creator_library SET payload = json_set(?, '$.revision', COALESCE(json_extract(payload, '$.revision'), 0) + 1) WHERE cell_id = ? AND tenant_id = ? AND kind = 'collection' AND id = ? AND creator_id = ? AND (? IS NULL OR json_extract(payload, '$.status') = ?) AND (? IS NULL OR COALESCE(json_extract(payload, '$.revision'), 0) = ?) AND ${availableSlug} AND ${validCollectionCover}`)
      .run(JSON.stringify(collection), this.local.configuration.cellId, collection.tenantId, collection.collectionId, collection.creatorId, expectedStatus ?? null, expectedStatus ?? null, expectedRevision ?? null, expectedRevision ?? null, ...this.slugParameters("collection", collection.collectionId, collection), ...this.coverParameters(collection));
    if (result.changes !== 1) {
      const current = this.get<C>(collection.tenantId, "collection", collection.collectionId);
      if (!current || current.creatorId !== collection.creatorId) throw new CreatorCollectionError("not_found", "Collection not found.");
      if (expectedRevision !== undefined && (current.revision ?? 0) !== expectedRevision) throw new CreatorCollectionError('revision_conflict', 'Collection changed; refresh before saving.');
      if (expectedStatus !== undefined && current.status !== expectedStatus) throw new CreatorCollectionError('revision_conflict', 'Collection status changed; refresh before saving.');
      this.requireStoredCover(collection);
      throw this.slugConflict("collection");
    }
  }
  async listCollectionWorks(tenantId: string, collectionId: string): Promise<CreatorCollectionMembership[]> {
    return this.get(tenantId, "membership", collectionId) ?? [];
  }
  async replaceCollectionWorks(tenantId: string, collectionId: string, works: CreatorCollectionMembership[], expectedWorkIds?: readonly string[]): Promise<void> {
    const db = this.local.database;
    this.local.transactionSync(() => {
      const collection = this.get<C>(tenantId, 'collection', collectionId);
      if (!collection || collection.status === 'deleted') throw new CreatorCollectionError('not_found', 'Collection not found.');
      const current = this.get<CreatorCollectionMembership[]>(tenantId, 'membership', collectionId) || [];
      if (expectedWorkIds !== undefined && (current.length !== expectedWorkIds.length || current.some((item, index) => item.workId !== expectedWorkIds[index]))) {
        throw new CreatorCollectionError('revision_conflict', 'Collection order changed; refresh before saving.');
      }
      if (new Set(works.map(work => work.workId)).size !== works.length || works.some((membership, position) => {
        const work = this.get<W>(tenantId, 'work', membership.workId);
        return membership.collectionId !== collectionId || membership.position !== position || !work || work.status === 'deleted' ||
          work.creatorId !== collection.creatorId || work.tenantId !== tenantId;
      })) throw new CreatorCollectionError('invalid_works', 'Choose Works owned by this Creator.');
      // Validate and replace without yielding or permitting another writer between them.
      db.prepare("INSERT INTO ubeeq_creator_library (cell_id, tenant_id, kind, id, creator_id, payload) VALUES (?, ?, 'membership', ?, ?, ?) ON CONFLICT(cell_id, tenant_id, kind, id) DO UPDATE SET payload = excluded.payload")
        .run(this.local.configuration.cellId, tenantId, collectionId, collection.creatorId, JSON.stringify(works));
    });
  }
}
