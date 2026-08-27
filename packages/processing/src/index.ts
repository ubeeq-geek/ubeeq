/** Mechanisms for media processing and measurement; products decide entitlement and price. */
export type UsageMeter = "storage_bytes" | "delivery_bytes" | "processing_units" | "transcode_seconds";

export interface ProcessingRequest {
  id: string;
  assetId: string;
  sourceVersionId: string;
  operation: string;
  idempotencyKey: string;
  requestedAt: string;
}

export interface ProcessingResult {
  requestId: string;
  state: "completed" | "failed" | "unavailable";
  outputReferences: readonly string[];
  measuredUnits: number;
  completedAt: string;
  errorCode?: string;
}

export interface ProcessedRendition { id: string; contentType: string; byteLength: number; role: "source" | "preview" | "poster"; }
export interface MediaProcessor { process(input: { assetId: string; contentType: string; source: Uint8Array; sourceVersionId: string }): Promise<{ metadata: Record<string, string | number | boolean>; renditions: readonly ProcessedRendition[]; measuredUnits: number }>; }

/** Local reference processor: validates common image headers and records source lineage without a vendor dependency. */
export class LocalImageProcessor implements MediaProcessor {
  async process(input: { assetId: string; contentType: string; source: Uint8Array; sourceVersionId: string }) {
    const bytes = input.source; let width: number | undefined; let height: number | undefined;
    if (input.contentType === "image/png" && bytes.length >= 24 && String.fromCharCode(...bytes.slice(1, 4)) === "PNG") { width = new DataView(bytes.buffer, bytes.byteOffset + 16, 8).getUint32(0); height = new DataView(bytes.buffer, bytes.byteOffset + 16, 8).getUint32(4); }
    if (input.contentType.startsWith("image/") && (!width || !height)) { /* Other image formats remain valid source-only local media until a processor extension supplies renditions. */ }
    return { metadata: { contentType: input.contentType, byteLength: bytes.byteLength, ...(width && height ? { width, height } : {}) }, renditions: [{ id: `source:${input.sourceVersionId}`, contentType: input.contentType, byteLength: bytes.byteLength, role: "source" as const }], measuredUnits: 1 };
  }
}

export interface UsageMeasurement {
  id: string;
  accountId: string;
  meter: UsageMeter;
  quantity: number;
  sourceId: string;
  observedAt: string;
  idempotencyKey: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface UsageMeterRepository {
  record(measurement: UsageMeasurement): Promise<{ created: boolean }>;
}

export const validateUsageMeasurement = (measurement: UsageMeasurement): void => {
  if (!measurement.accountId.trim() || !measurement.sourceId.trim() || !measurement.idempotencyKey.trim()) throw new Error("Usage measurement identity is required");
  if (!Number.isFinite(measurement.quantity) || measurement.quantity < 0) throw new Error("Usage measurement quantity must be a non-negative finite number");
};

export const recordUsageMeasurement = async (repository: UsageMeterRepository, measurement: UsageMeasurement): Promise<{ created: boolean }> => {
  validateUsageMeasurement(measurement);
  return repository.record(measurement);
};
