import { isIP, BlockList } from 'node:net';

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
  /** Additional endpoint origins approved independently of the discovery response. */
  trustedEndpointOrigins?: readonly string[];
}

const nonPublicV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) nonPublicV4.addSubnet(address, prefix, 'ipv4');
const nonPublicV6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const)
  nonPublicV6.addSubnet(address, prefix, 'ipv6');

const privateAddress = (address: string): boolean => {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const family = isIP(value);
  if (family === 4) return nonPublicV4.check(value, 'ipv4');
  // Only global unicast IPv6, excluding transition/documentation ranges.
  // This also rejects IPv4-mapped loopback/private addresses.
  if (family === 6) return !/^[23][0-9a-f]{3}:/.test(value) || nonPublicV6.check(value, 'ipv6');
  return value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local') || !value.includes('.');
};

const text = (value: unknown, field: string, maximum = 2048): string => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maximum || /[\u0000-\u0020\u007f]/.test(value))
    throw new Error(`${field} must be a nonempty bounded string without whitespace or control characters.`);
  return value;
};
const parsedUrl = (value: unknown, field: string): URL => {
  let url: URL;
  try { url = new URL(text(value, field)); } catch { throw new Error(`${field} must be an absolute URL.`); }
  if (url.username || url.password) throw new Error(`${field} must not contain credentials.`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${field} uses an unsupported scheme.`);
  if (url.hash) throw new Error(`${field} must not contain a fragment.`);
  return url;
};
const stringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${field} must be a bounded array.`);
  return value.map(item => text(item, field, 200));
};
const capabilities = new Set<UbeeqCapability>(['inventory.read', 'assets.original.read', 'assets.stage', 'publications.create',
  'publications.update', 'publications.activate', 'collections.read', 'collections.write', 'jobs.read']);

/** Validate untrusted discovery metadata before authorization or credential use. */
export const validateUbeeqDiscovery = (input: unknown, options: DiscoveryValidationOptions): UbeeqDiscoveryDocument => {
  if (options.production && options.allowPrivateNetwork) throw new Error('Private-network exceptions are limited to nonproduction connections.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Discovery must be an object.');
  const document = input as Record<string, unknown>;
  const instanceId = text(document.instanceId, 'Discovery instanceId', 200);
  const service = text(document.service, 'Discovery service', 200);
  const versions = stringArray(document.protocolVersions, 'Protocol versions');
  if (versions.some(version => !/^\d+\.\d+(?:\.\d+)?$/.test(version))) throw new Error('Invalid protocol version.');
  if (!versions.some(version => version.split('.')[0] === String(UBEEQ_COMPATIBLE_PROTOCOL_MAJOR))) {
    throw new Error(`Unsupported Ubeeq-compatible protocol version; major ${UBEEQ_COMPATIBLE_PROTOCOL_MAJOR} is required.`);
  }
  const offered = stringArray(document.capabilities, 'Capabilities');
  const requested = parsedUrl(options.requestedOrigin, 'Requested origin');
  const canonical = parsedUrl(document.canonicalOrigin, 'Canonical origin');
  const api = parsedUrl(document.apiBaseUrl, 'API base URL');
  const authorization = parsedUrl(document.authorizationEndpoint, 'Authorization endpoint');
  if (api.search) throw new Error('API base URL must not contain a query.');
  if (!api.pathname.endsWith('/')) api.pathname += '/';
  for (const url of [requested, canonical]) {
    if (url.pathname !== '/' || url.search) throw new Error('Requested and canonical origins must be origins without paths or queries.');
  }
  if (canonical.origin !== requested.origin) throw new Error('Canonical origin differs from the requested origin.');
  const trusted = new Set([requested.origin, ...(options.trustedEndpointOrigins || []).map(value => parsedUrl(value, 'Trusted endpoint origin').origin)]);
  for (const url of [requested, canonical, api, authorization]) {
    if (options.production && url.protocol !== 'https:') throw new Error('HTTPS is required for production connections.');
    if (!options.allowPrivateNetwork && privateAddress(url.hostname)) throw new Error('Private-network integration endpoints are forbidden.');
    if (!trusted.has(url.origin)) throw new Error('Endpoint origin requires independent approval.');
  }
  if (options.resolvedAddresses && (!options.resolvedAddresses.length || options.resolvedAddresses.some(address => !isIP(address))))
    throw new Error('Resolved addresses must contain valid IP addresses.');
  if (!options.allowPrivateNetwork && options.resolvedAddresses?.some(privateAddress)) throw new Error('Discovery resolved to a forbidden private-network address.');
  let extensions: Record<string, string> | undefined;
  if (document.extensions !== undefined) {
    if (!document.extensions || typeof document.extensions !== 'object' || Array.isArray(document.extensions) || Object.keys(document.extensions).length > 100)
      throw new Error('Extensions must be a bounded string record.');
    extensions = Object.fromEntries(Object.entries(document.extensions).map(([key, value]) => [text(key, 'Extension key', 200), text(value, 'Extension value')]));
  }
  return { instanceId, service, canonicalOrigin: canonical.origin, apiBaseUrl: api.href, authorizationEndpoint: authorization.href,
    capabilities: [...new Set(offered.filter((capability): capability is UbeeqCapability => capabilities.has(capability as UbeeqCapability)))].sort(),
    protocolVersions: [...new Set(versions)].sort(), ...(extensions ? { extensions } : {}) };
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
  for (const mapping of mappings) {
    for (const field of ['localPublicationId', 'instanceId', 'remoteAccountId', 'remoteSpaceId', 'remotePublicationId', 'remoteRevision'] as const)
      text(mapping[field], `Publication mapping ${field}`, 500);
    if (!['active', 'tombstoned', 'replaced'].includes(mapping.lifecycle)) throw new Error('Invalid publication mapping lifecycle.');
    if (mapping.lifecycle !== 'active') continue;
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
  "invalid_asset" | "temporarily_unavailable" | "invalid_request";

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
    existing.connectionId === attempted.connectionId && existing.direction === attempted.direction &&
    ubeeqTargetKey(existing) === ubeeqTargetKey(attempted);
  if (!sameScope || existing.payloadFingerprint !== attempted.payloadFingerprint) throw new Error("Idempotency key was reused with different target, operation, or content.");
  if (existing.status === "completed") return "return_existing";
  return "resume";
};

export const requireSafePublicationActivation = (input: {
  requestedAccess: "public" | "premium" | "private";
  supportedAccess: readonly ("public" | "premium" | "private")[];
  assetsReady: boolean;
  accessSettingsReady: boolean;
  supportsStagingOrDraft: boolean;
}): void => {
  if (!["public", "premium", "private"].includes(input.requestedAccess) || !input.supportedAccess.includes(input.requestedAccess)) throw new Error(`Destination does not support requested ${input.requestedAccess} access.`);
  if (input.supportsStagingOrDraft !== true) throw new Error("Destination must support staging or a safe draft equivalent.");
  if (input.assetsReady !== true || input.accessSettingsReady !== true) throw new Error("Publication cannot be activated before assets and access settings are ready.");
};

/** Read-only v1 host profile. Paths are relative to the discovered API base URL. */
export const UBEEQ_CAPABILITIES_PATH = 'capabilities';
export const UBEEQ_INVENTORY_PATH = 'inventory';
export interface UbeeqTargetCapabilities extends UbeeqRemoteTarget {
  capabilities: readonly UbeeqCapability[];
}
/** Metadata only; this response never grants original access or publication rights. */
export interface UbeeqInventoryWork {
  workId: string;
  revision: string;
  title: string;
  kind: string;
  status: string;
  updatedAt: string;
}
export interface UbeeqInventoryPage extends UbeeqRemoteTarget {
  items: readonly UbeeqInventoryWork[];
  nextCursor?: string;
}
