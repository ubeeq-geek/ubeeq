import { createHash, randomUUID } from "node:crypto";
import type { CreatorAssetProcessingPort, CreatorAssetRendition } from "@ubeeq/core";
import { snapshotCreatorSquareCrop } from '@ubeeq/core';
import type { JobQueue } from "@ubeeq/jobs";
import type { ObjectStorage } from "@ubeeq/storage";
import type { MediaProcessor } from "./index.js";

export interface CreatorAssetProcessingJob { tenantId: string; creatorId: string; workId: string; assetId: string; sourceVersionId: string; squareCrop?: import('./image-crops.js').SquareCropInput }

/** One bounded durable attempt. The store atomically fences result commit and job completion. */
export class CreatorAssetWorker {
  constructor(private readonly options: { cellId: string; workerId: string; jobs: JobQueue;
    assets: CreatorAssetProcessingPort; storage: ObjectStorage; processor: MediaProcessor; maxSourceBytes?: number; maxOutputBytes?: number; allowSquareCrop?: boolean }) {
    for (const value of [options.maxSourceBytes, options.maxOutputBytes]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error("Media byte budgets must be positive integers.");
    }
  }
  async runNext(): Promise<{ jobId: string; state: "completed" | "retry_scheduled" | "dead_lettered" } | undefined> {
    const { cellId, workerId, jobs, assets, storage, processor } = this.options;
    const lease = await jobs.lease<CreatorAssetProcessingJob>({ cellId, workerId, types: ["creator-asset.process"], leaseDurationSeconds: 60 });
    if (!lease) return undefined;
    if (lease.job.cellId !== cellId || lease.job.type !== "creator-asset.process") throw new Error("Worker received a foreign job.");
    try {
      const scope = structuredClone(lease.job.payload);
      if (!scope || [scope.tenantId, scope.creatorId, scope.workId, scope.assetId, scope.sourceVersionId].some((value) => typeof value !== "string" || !value)) throw new Error("Invalid processing job scope.");
      const squareCrop = snapshotCreatorSquareCrop(scope.squareCrop);
      if (squareCrop && !this.options.allowSquareCrop) throw new Error('Square crop processing is not enabled.');
      const asset = await assets.getProcessingAsset(scope.tenantId, scope.assetId);
      if (!asset || asset.tenantId !== scope.tenantId || asset.assetId !== scope.assetId || asset.creatorId !== scope.creatorId || asset.status === "deleted" || asset.storage.versionId !== scope.sourceVersionId || asset.storage.scope !== "private") throw new Error("Processing source changed or is unavailable.");
      if (squareCrop && !asset.mimeType.startsWith('image/')) throw new Error('Square crop requires an image source.');
      if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0 || asset.sizeBytes > (this.options.maxSourceBytes ?? 50 * 1024 * 1024)) throw new Error("Processing source exceeds byte budget.");
      const original = await storage.get(asset.storage);
      if (original.body.byteLength !== asset.sizeBytes || createHash("sha256").update(original.body).digest("hex") !== asset.checksumSha256) throw new Error("Processing source failed integrity verification.");
      const output = await processor.process({ assetId: asset.assetId, sourceVersionId: scope.sourceVersionId, contentType: asset.mimeType, source: original.body, ...(squareCrop ? { squareCrop } : {}) });
      const previews = output.renditions.filter((item) => item.role !== "source");
      if (!previews.length || previews.length > 16 || new Set(previews.map((item) => item.id)).size !== previews.length) throw new Error("Invalid processor rendition set.");
      let outputBytes = 0;
      // Validate the complete set before storing any output, including later renditions.
      for (const item of previews) {
        if (!item.id || !["preview", "poster"].includes(item.role) || !item.contentType || item.sourceVersionId !== scope.sourceVersionId ||
          !(item.body instanceof Uint8Array) || !item.body.byteLength || item.byteLength !== item.body.byteLength) throw new Error("Invalid processor output lineage or bytes.");
        outputBytes += item.body.byteLength;
      }
      if (outputBytes > (this.options.maxOutputBytes ?? 50 * 1024 * 1024)) throw new Error("Processing output exceeds byte budget.");
      const renditions: CreatorAssetRendition[] = [];
      for (const item of previews) {
        const body = item.body!;
        // Attempt-specific immutable keys prevent an expired worker overwriting a winner.
        const id = randomUUID();
        const object = { bucket: "creator-renditions", key: `cells/${cellId}/creators/${scope.creatorId}/renditions/${id}`,
          versionId: id, contentType: item.contentType, byteLength: body.byteLength,
          checksum: createHash("sha256").update(body).digest("hex"), scope: "private" as const };
        await storage.put({ object, body });
        renditions.push({ id: item.id, sourceVersionId: scope.sourceVersionId, role: item.role as "preview" | "poster", storage: object });
      }
      await assets.commitAssetProcessing({ ...scope, jobId: lease.job.id, leaseToken: lease.leaseToken, metadata: output.metadata, renditions });
      return { jobId: lease.job.id, state: "completed" };
    } catch (error) {
      // Preserve objects on ambiguous commits. Recovery/GC must not delete a winning result.
      const current = await jobs.get(lease.job.id);
      if (current?.state === "completed") return { jobId: lease.job.id, state: "completed" };
      const failure = { id: lease.job.id, leaseToken: lease.leaseToken, error: { code: "asset_processing_failed", message: error instanceof Error ? error.message : "Processing failed" } };
      if (lease.job.attempt >= lease.job.maxAttempts) {
        await jobs.deadLetter(failure);
        return { jobId: lease.job.id, state: "dead_lettered" };
      }
      await jobs.retry({ ...failure, retryAt: new Date(Date.now() + 1000).toISOString() });
      return { jobId: lease.job.id, state: "retry_scheduled" };
    }
  }
}
