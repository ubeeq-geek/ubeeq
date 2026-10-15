/** Shared protocol contracts for Ubeeq-compatible hosts and branded presets. */

export const UBEEQ_COMPATIBLE_PROTOCOL_MAJOR = 1;
export const UBEEQ_DISCOVERY_PATH = "/.well-known/ubeeq";

export type UbeeqCompatiblePreset = string;
export const UBEEQ_COMPATIBLE_CONNECTOR_FAMILY = "ubeeq-compatible" as const;

export interface UbeeqCompatibleCatalogEntry {
  id: UbeeqCompatiblePreset;
  label: string;
  connectorFamily: typeof UBEEQ_COMPATIBLE_CONNECTOR_FAMILY;
  setup: "discover_url" | "official_endpoint";
}

/** Product catalog entries; every entry deliberately resolves to one connector. */
export const UBEEQ_COMPATIBLE_CATALOG_ENTRY: UbeeqCompatibleCatalogEntry =
  { id: "ubeeq-compatible", label: "Ubeeq-compatible site", connectorFamily: UBEEQ_COMPATIBLE_CONNECTOR_FAMILY, setup: "discover_url" };

/** Compose product-owned service presets without creating connector implementations. */
export const createUbeeqCompatibleCatalog = (presets: readonly Omit<UbeeqCompatibleCatalogEntry, "connectorFamily">[]): readonly UbeeqCompatibleCatalogEntry[] => {
  const entries: UbeeqCompatibleCatalogEntry[] = [UBEEQ_COMPATIBLE_CATALOG_ENTRY, ...presets.map((entry) => ({ ...entry, connectorFamily: UBEEQ_COMPATIBLE_CONNECTOR_FAMILY }))];
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) throw new Error("Integration catalog preset IDs must be unique.");
  return entries;
};

export type UbeeqServiceClassification = string;
export type UbeeqCapability =
  | "inventory.read" | "assets.original.read" | "assets.stage"
  | "publications.create" | "publications.update" | "publications.activate"
  | "collections.read" | "collections.write" | "jobs.read";

export interface UbeeqDiscoveryDocument {
  instanceId: string;
  canonicalOrigin: string;
  apiBaseUrl: string;
  protocolVersions: readonly string[];
  authorizationEndpoint: string;
  service: UbeeqServiceClassification;
  capabilities: readonly UbeeqCapability[];
  extensions?: Readonly<Record<string, string>>;
}

export interface DiscoveryValidationOptions {
  requestedOrigin: string;
  production?: boolean;
  allowPrivateNetwork?: boolean;
  resolvedAddresses?: readonly string[];
}

const privateAddress = (address: string): boolean => {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "::1" || value.startsWith("127.") || value.startsWith("10.") ||
    value.startsWith("192.168.") || value.startsWith("169.254.") || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(value);
};

const parsedUrl = (value: string, field: string): URL => {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${field} must be an absolute URL.`); }
  if (url.username || url.password) throw new Error(`${field} must not contain credentials.`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${field} uses an unsupported scheme.`);
  return url;
};

/** Validate untrusted discovery metadata before authorization or credential use. */
export const validateUbeeqDiscovery = (document: UbeeqDiscoveryDocument, options: DiscoveryValidationOptions): UbeeqDiscoveryDocument => {
  if (!document.instanceId.trim()) throw new Error("Discovery instanceId is required.");
  if (!document.protocolVersions.some((version) => Number(version.split('.')[0]) === UBEEQ_COMPATIBLE_PROTOCOL_MAJOR)) {
    throw new Error(`Unsupported Ubeeq-compatible protocol version; major ${UBEEQ_COMPATIBLE_PROTOCOL_MAJOR} is required.`);
  }
  const requested = parsedUrl(options.requestedOrigin, "Requested origin");
  const canonical = parsedUrl(document.canonicalOrigin, "Canonical origin");
  const api = parsedUrl(document.apiBaseUrl, "API base URL");
  const authorization = parsedUrl(document.authorizationEndpoint, "Authorization endpoint");
  for (const url of [requested, canonical, api, authorization]) {
    if (options.production && url.protocol !== "https:") throw new Error("HTTPS is required for production connections.");
    if (!options.allowPrivateNetwork && privateAddress(url.hostname)) throw new Error("Private-network integration endpoints are forbidden.");
  }
  if (!options.allowPrivateNetwork && options.resolvedAddresses?.some(privateAddress)) throw new Error("Discovery resolved to a forbidden private-network address.");
  return { ...document, capabilities: [...new Set(document.capabilities)].sort(), protocolVersions: [...new Set(document.protocolVersions)].sort() };
};

export const presetForDiscoveredService = (selected: UbeeqCompatiblePreset, verifiedPresetId?: string): UbeeqCompatiblePreset =>
  selected === "ubeeq-compatible" && verifiedPresetId?.trim() ? verifiedPresetId : selected;

export type UbeeqConnectionState = "pending" | "active" | "reauthorization_required" | "revoked";
export interface UbeeqCompatibleConnection {
  connectionId: string;
  preset: UbeeqCompatiblePreset;
  instanceId: string;
  remoteAccountId: string;
  credentialReference: string;
  grantedScopes: readonly string[];
  permittedSpaceIds: readonly string[];
  state: UbeeqConnectionState;
  label: string;
  lastSuccessfulOperationAt?: string;
}

export interface UbeeqRemoteTarget { instanceId: string; remoteAccountId: string; remoteSpaceId: string; }
export const ubeeqTargetKey = (target: UbeeqRemoteTarget): string =>
  JSON.stringify([target.instanceId, target.remoteAccountId, target.remoteSpaceId]);

export interface UbeeqPublicationMapping extends UbeeqRemoteTarget {
  localPublicationId: string;
  remoteWorkId?: string;
  remotePublicationId: string;
  remoteRevision: string;
  lifecycle: "active" | "tombstoned" | "replaced";
}

export const ubeeqPublicationMappingKey = (mapping: Pick<UbeeqPublicationMapping, "localPublicationId" | keyof UbeeqRemoteTarget>): string =>
  JSON.stringify([mapping.localPublicationId, mapping.instanceId, mapping.remoteAccountId, mapping.remoteSpaceId]);

/** Enforces publication-to-target identity, without incorrectly making a work unique. */
export const assertUbeeqPublicationMappings = (mappings: readonly UbeeqPublicationMapping[]): void => {
  const activeKeys = new Set<string>();
  const remoteKeys = new Set<string>();
  for (const mapping of mappings.filter((item) => item.lifecycle === "active")) {
    const key = ubeeqPublicationMappingKey(mapping);
    if (activeKeys.has(key)) throw new Error("An active publication mapping already exists for this target.");
    activeKeys.add(key);
    const remoteKey = JSON.stringify([ubeeqTargetKey(mapping), mapping.remotePublicationId]);
    if (remoteKeys.has(remoteKey)) throw new Error("A remote publication is associated with more than one active mapping.");
    remoteKeys.add(remoteKey);
  }
};

export const availableUbeeqCapabilities = (...sets: readonly (readonly UbeeqCapability[])[]): UbeeqCapability[] => {
  if (!sets.length) return [];
  return [...new Set(sets[0])].filter((capability) => sets.every((set) => set.includes(capability))).sort();
};

export type UbeeqProtocolErrorCode = "unsupported_version" | "unsupported_capability" | "authorization_required" |
  "permission_denied" | "policy_rejected" | "quota_exceeded" | "revision_conflict" | "rate_limited" |
  "invalid_asset" | "temporarily_unavailable";

export interface UbeeqProtocolError {
  code: UbeeqProtocolErrorCode;
  message: string;
  affectedObject?: { type: string; id: string };
  retryAfterSeconds?: number;
}

export interface UbeeqTransferJob extends UbeeqRemoteTarget {
  jobId: string;
  connectionId: string;
  direction: "import" | "publish";
  operation: "inventory" | "asset" | "publication_create" | "publication_update" | "collection_membership";
  idempotencyKey: string;
  payloadFingerprint: string;
  status: "pending" | "running" | "partially_completed" | "completed" | "failed" | "reconciliation_required";
  checkpoint?: string;
  remoteResultId?: string;
}

/** A persisted key may only be replayed for the same operation, target, and content. */
export const resolveUbeeqIdempotentJob = (existing: UbeeqTransferJob | undefined, attempted: UbeeqTransferJob): "submit" | "resume" | "return_existing" => {
  if (!existing) return "submit";
  const sameScope = existing.idempotencyKey === attempted.idempotencyKey && existing.operation === attempted.operation &&
    ubeeqTargetKey(existing) === ubeeqTargetKey(attempted);
  if (!sameScope || existing.payloadFingerprint !== attempted.payloadFingerprint) throw new Error("Idempotency key was reused with different target, operation, or content.");
  if (existing.remoteResultId || existing.status === "completed") return "return_existing";
  return "resume";
};

export const requireSafePublicationActivation = (input: {
  requestedAccess: "public" | "premium" | "private";
  supportedAccess: readonly ("public" | "premium" | "private")[];
  assetsReady: boolean;
  accessSettingsReady: boolean;
  supportsStagingOrDraft: boolean;
}): void => {
  if (!input.supportedAccess.includes(input.requestedAccess)) throw new Error(`Destination does not support requested ${input.requestedAccess} access.`);
  if (!input.supportsStagingOrDraft) throw new Error("Destination must support staging or a safe draft equivalent.");
  if (!input.assetsReady || !input.accessSettingsReady) throw new Error("Publication cannot be activated before assets and access settings are ready.");
};
