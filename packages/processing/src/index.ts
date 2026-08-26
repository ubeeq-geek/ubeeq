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

