/** Neutral, portable configuration required by a self-hosted Ubeeq instance. */
export interface SelfHostConfiguration {
  instanceId: string;
  cell: { id: string; region: string; operator: string; backupPolicy: string };
  publicOrigin: string;
  storage: { adapter: string; dataDirectory?: string };
  extensions: readonly { id: string; apiVersion: string }[];
}

export class SelfHostConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfHostConfigurationError";
  }
}

const isLoopback = (hostname: string): boolean => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

/** Validates portable instance settings without selecting a hosted product policy. */
export const validateSelfHostConfiguration = (input: SelfHostConfiguration): SelfHostConfiguration => {
  if (!input.instanceId.trim() || !/^[a-z0-9][a-z0-9-]{1,62}$/i.test(input.instanceId)) {
    throw new SelfHostConfigurationError("instanceId must contain 2-63 letters, numbers, or hyphens.");
  }
  let origin: URL;
  try { origin = new URL(input.publicOrigin); }
  catch { throw new SelfHostConfigurationError("publicOrigin must be an absolute URL."); }
  if (origin.pathname !== "/" || origin.search || origin.hash || !["http:", "https:"].includes(origin.protocol)) {
    throw new SelfHostConfigurationError("publicOrigin must be an HTTP(S) origin without a path, query, or fragment.");
  }
  if (origin.protocol !== "https:" && !isLoopback(origin.hostname)) {
    throw new SelfHostConfigurationError("publicOrigin must use HTTPS except for a loopback development instance.");
  }
  if (!input.storage.adapter.trim()) throw new SelfHostConfigurationError("A storage adapter is required.");
  if (!input.cell?.id?.trim() || !input.cell.region?.trim() || !input.cell.operator?.trim() || !input.cell.backupPolicy?.trim()) {
    throw new SelfHostConfigurationError("Cell id, region, operator, and backup policy are required.");
  }
  if (input.storage.adapter === "local" && !input.storage.dataDirectory?.trim()) {
    throw new SelfHostConfigurationError("Local storage requires dataDirectory.");
  }
  const extensionIds = input.extensions.map(({ id }) => id);
  if (extensionIds.some((id) => !id.trim()) || new Set(extensionIds).size !== extensionIds.length) {
    throw new SelfHostConfigurationError("Extension ids must be non-empty and unique.");
  }
  return input;
};

export interface CellDiagnostic { cellId: string; region: string; operator: string; backupPolicy: string; mode: "single-cell"; }
export const describeCell = (configuration: SelfHostConfiguration): CellDiagnostic => ({ ...configuration.cell, cellId: configuration.cell.id, mode: "single-cell" });
