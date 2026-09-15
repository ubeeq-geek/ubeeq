import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
export { assembleCreatorContentExport } from './content-export.js';
export { parseCreatorContentExport } from './content-export-validation.js';
export { planCreatorContentImport, type CreatorContentImportInventory } from './content-import-plan.js';
import type { AssetRecord, AuditEventRecord, CollectionRecord, CreatorRecord, ExportManifestRecord, ImportCheckpointRecord, IntegrationAccountRecord, ModerationEvidenceRecord, ModerationHoldRecord, PublicationIntentRecord, PublicationRecord, ReviewCaseRecord, UsageEventRecord, WorkRecord } from "@ubeeq/persistence";

export const CREATOR_EXPORT_SCHEMA_VERSION = "2" as const;
export interface ExportObjectInventory { assetId: string; key?: string; versionId: string; checksum: string; byteLength?: number; transferState: "manifest_only"; }
export interface PortableProcessingState { id: string; assetId: string; homeCellId: string; dataHomeRegion: string; dataHomeAssignedAt: string; routingRevision: number; state: string; }
export type SanitizedIntegrationAccount = Omit<IntegrationAccountRecord, "credentialReference"> & { credentialExcluded: true };

export interface CreatorExportManifest {
  schemaVersion: typeof CREATOR_EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  creator: CreatorRecord;
  works: readonly WorkRecord[];
  assets: readonly AssetRecord[];
  collections: readonly CollectionRecord[];
  publications: readonly PublicationRecord[];
  publicationIntents: readonly PublicationIntentRecord[];
  processing: readonly PortableProcessingState[];
  moderationEvidence: readonly ModerationEvidenceRecord[];
  moderationHolds: readonly ModerationHoldRecord[];
  reviewCases: readonly ReviewCaseRecord[];
  auditEvents: readonly AuditEventRecord[];
  usageEvents: readonly UsageEventRecord[];
  integrationAccounts: readonly SanitizedIntegrationAccount[];
  exportCheckpoints: readonly ExportManifestRecord[];
  importCheckpoints: readonly ImportCheckpointRecord[];
  objectInventory: readonly ExportObjectInventory[];
  exclusions: readonly ["credentials", "secrets", "transient_worker_leases", "live_queue_state", "provider_runtime_state", "original_object_bytes"];
  secretsExcluded: true;
  checksum: string;
}

export interface ImportConflict { resource: "work" | "asset" | "collection" | "publication" | "publicationIntent" | "moderationEvidence" | "moderationHold" | "reviewCase" | "auditEvent" | "usageEvent" | "integrationAccount"; id: string; reason: "id_exists" | "creator_mismatch"; }
export interface ImportPlan { valid: boolean; conflicts: readonly ImportConflict[]; itemCounts: { works: number; assets: number; collections: number; publications: number; publicationIntents: number; moderationRecords: number; auditEvents: number; usageEvents: number; integrationAccounts: number }; }

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
  return value;
};
export const stableJson = (value: unknown): string => JSON.stringify(canonicalize(value));
export const exportChecksum = (manifest: Omit<CreatorExportManifest, "checksum">): string => createHash("sha256").update(stableJson(manifest)).digest("hex");

export const createCreatorExport = (input: Omit<CreatorExportManifest, "schemaVersion" | "checksum" | "secretsExcluded" | "exclusions">): CreatorExportManifest => {
  const manifest = { ...input, schemaVersion: CREATOR_EXPORT_SCHEMA_VERSION, secretsExcluded: true as const, exclusions: ["credentials", "secrets", "transient_worker_leases", "live_queue_state", "provider_runtime_state", "original_object_bytes"] as const };
  return { ...manifest, checksum: exportChecksum(manifest) };
};

const containsSecret = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsSecret);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => /^(token|password|secret|credential|authorization)$/i.test(key) || containsSecret(item));
};

export const validateCreatorExport = (value: unknown): CreatorExportManifest => {
  if (!value || typeof value !== "object") throw new Error("Export manifest must be an object.");
  const candidate = value as CreatorExportManifest;
  const manifest: CreatorExportManifest = {
    schemaVersion: candidate.schemaVersion, exportedAt: candidate.exportedAt, creator: candidate.creator,
    works: candidate.works, assets: candidate.assets, collections: candidate.collections, publications: candidate.publications,
    publicationIntents: candidate.publicationIntents, processing: candidate.processing, moderationEvidence: candidate.moderationEvidence,
    moderationHolds: candidate.moderationHolds, reviewCases: candidate.reviewCases, auditEvents: candidate.auditEvents,
    usageEvents: candidate.usageEvents, integrationAccounts: candidate.integrationAccounts, exportCheckpoints: candidate.exportCheckpoints,
    importCheckpoints: candidate.importCheckpoints, objectInventory: candidate.objectInventory, exclusions: candidate.exclusions,
    secretsExcluded: candidate.secretsExcluded, checksum: candidate.checksum,
  };
  if (manifest.schemaVersion !== CREATOR_EXPORT_SCHEMA_VERSION) throw new Error(`Unsupported export schema version: ${String(manifest.schemaVersion)}.`);
  const arrays = [manifest.works, manifest.assets, manifest.collections, manifest.publications, manifest.publicationIntents, manifest.processing, manifest.moderationEvidence, manifest.moderationHolds, manifest.reviewCases, manifest.auditEvents, manifest.usageEvents, manifest.integrationAccounts, manifest.exportCheckpoints, manifest.importCheckpoints, manifest.objectInventory, manifest.exclusions];
  if (!manifest.creator?.id || arrays.some((items) => !Array.isArray(items))) throw new Error("Export manifest is missing required creator content arrays.");
  if (!manifest.creator.homeCellId || !manifest.creator.dataHomeRegion || !manifest.creator.dataHomeAssignedAt || Number.isNaN(Date.parse(manifest.creator.dataHomeAssignedAt)) || !Number.isSafeInteger(manifest.creator.routingRevision)) throw new Error("Export creator is missing data-home information.");
  if (manifest.secretsExcluded !== true || containsSecret(manifest)) throw new Error("Export manifests must exclude credentials and secrets.");
  const requiredExclusions = ["credentials", "secrets", "transient_worker_leases", "live_queue_state", "provider_runtime_state", "original_object_bytes"];
  if (manifest.exclusions.length !== requiredExclusions.length || requiredExclusions.some((item, index) => manifest.exclusions[index] !== item)) throw new Error("Export manifest exclusions are incomplete or reordered.");
  const { checksum: _checksum, ...unsigned } = manifest;
  if (!manifest.checksum || exportChecksum(unsigned) !== manifest.checksum) throw new Error("Export manifest checksum does not match its contents.");
  const creatorId = manifest.creator.id;
  if (manifest.works.some((work) => work.creatorId !== creatorId) || manifest.assets.some((asset) => asset.creatorId !== creatorId) || manifest.collections.some((collection) => collection.creatorId !== creatorId) || manifest.integrationAccounts.some((account) => account.creatorId !== creatorId || "credentialReference" in account || account.credentialExcluded !== true) || manifest.exportCheckpoints.some((checkpoint) => checkpoint.creatorId !== creatorId) || manifest.importCheckpoints.some((checkpoint) => checkpoint.creatorId !== creatorId)) throw new Error("Export manifest contains records owned by another creator or a credential reference.");
  const unique = (name: string, records: readonly { id: string }[]) => { if (new Set(records.map(({ id }) => id)).size !== records.length) throw new Error(`Export manifest contains duplicate ${name} IDs.`); };
  for (const [name, records] of Object.entries({ works: manifest.works, assets: manifest.assets, collections: manifest.collections, publications: manifest.publications, publicationIntents: manifest.publicationIntents, processing: manifest.processing, moderationEvidence: manifest.moderationEvidence, moderationHolds: manifest.moderationHolds, reviewCases: manifest.reviewCases, auditEvents: manifest.auditEvents, usageEvents: manifest.usageEvents, integrationAccounts: manifest.integrationAccounts })) unique(name, records);
  const workIds = new Set(manifest.works.map(({ id }) => id)); const assetIds = new Set(manifest.assets.map(({ id }) => id)); const subjectIds = new Set([creatorId, ...workIds, ...assetIds]);
  if (manifest.publications.some(({ workId }) => !workIds.has(workId)) || manifest.publicationIntents.some(({ workId }) => !workIds.has(workId)) || manifest.processing.some(({ assetId }) => !assetIds.has(assetId)) || [...manifest.moderationEvidence, ...manifest.moderationHolds, ...manifest.reviewCases].some(({ subjectId }) => !subjectIds.has(subjectId))) throw new Error("Export manifest contains a dangling creator-owned relationship.");
  if (manifest.objectInventory.length !== manifest.assets.length || manifest.objectInventory.some((object) => !assetIds.has(object.assetId) || !object.versionId || !/^[a-f0-9]{64}$/i.test(object.checksum) || (object.byteLength !== undefined && (!Number.isSafeInteger(object.byteLength) || object.byteLength < 0)) || (object.key !== undefined && !object.key.startsWith(`cells/${manifest.creator.homeCellId}/creators/${creatorId}/`)))) throw new Error("Export object inventory is incomplete or invalid.");
  const owned = [...manifest.works, ...manifest.assets, ...manifest.collections, ...manifest.publications, ...manifest.publicationIntents, ...manifest.processing, ...manifest.moderationEvidence, ...manifest.moderationHolds, ...manifest.reviewCases, ...manifest.auditEvents, ...manifest.usageEvents, ...manifest.integrationAccounts, ...manifest.exportCheckpoints, ...manifest.importCheckpoints];
  const foreign = owned.some((record) => record.homeCellId !== manifest.creator.homeCellId || record.dataHomeRegion !== manifest.creator.dataHomeRegion || record.dataHomeAssignedAt !== manifest.creator.dataHomeAssignedAt || record.routingRevision !== manifest.creator.routingRevision);
  if (foreign) throw new Error("Export manifest contains records from another data home.");
  return manifest;
};

export const planCreatorImport = (manifest: CreatorExportManifest, input: { existingWorkIds: readonly string[]; existingAssetIds: readonly string[]; existingCollectionIds: readonly string[]; targetCreatorId: string; existingIds?: Partial<Record<Exclude<ImportConflict["resource"], "work" | "asset" | "collection">, readonly string[]>> }): ImportPlan => {
  const conflicts: ImportConflict[] = [];
  const addConflicts = (resource: ImportConflict["resource"], records: readonly { id: string; creatorId: string }[], existing: readonly string[]) => records.forEach((record) => {
    if (record.creatorId !== manifest.creator.id) conflicts.push({ resource, id: record.id, reason: "creator_mismatch" });
    else if (existing.includes(record.id)) conflicts.push({ resource, id: record.id, reason: "id_exists" });
  });
  addConflicts("work", manifest.works, input.existingWorkIds); addConflicts("asset", manifest.assets, input.existingAssetIds); addConflicts("collection", manifest.collections, input.existingCollectionIds);
  const addIds = (resource: Exclude<ImportConflict["resource"], "work" | "asset" | "collection">, records: readonly { id: string }[]) => records.forEach(({ id }) => { if (input.existingIds?.[resource]?.includes(id)) conflicts.push({ resource, id, reason: "id_exists" }); });
  addIds("publication", manifest.publications); addIds("publicationIntent", manifest.publicationIntents); addIds("moderationEvidence", manifest.moderationEvidence); addIds("moderationHold", manifest.moderationHolds); addIds("reviewCase", manifest.reviewCases); addIds("auditEvent", manifest.auditEvents); addIds("usageEvent", manifest.usageEvents); addIds("integrationAccount", manifest.integrationAccounts);
  return { valid: conflicts.length === 0, conflicts, itemCounts: { works: manifest.works.length, assets: manifest.assets.length, collections: manifest.collections.length, publications: manifest.publications.length, publicationIntents: manifest.publicationIntents.length, moderationRecords: manifest.moderationEvidence.length + manifest.moderationHolds.length + manifest.reviewCases.length, auditEvents: manifest.auditEvents.length, usageEvents: manifest.usageEvents.length, integrationAccounts: manifest.integrationAccounts.length } };
};

export interface CreatorImportIdMap {
  creatorId: string;
  works: Readonly<Record<string, string>>;
  assets: Readonly<Record<string, string>>;
  collections: Readonly<Record<string, string>>;
  publications: Readonly<Record<string, string>>;
  publicationIntents: Readonly<Record<string, string>>;
  processing: Readonly<Record<string, string>>;
  moderationEvidence: Readonly<Record<string, string>>;
  moderationHolds: Readonly<Record<string, string>>;
  reviewCases: Readonly<Record<string, string>>;
  auditEvents: Readonly<Record<string, string>>;
  usageEvents: Readonly<Record<string, string>>;
  integrationAccounts: Readonly<Record<string, string>>;
  exportCheckpoints: Readonly<Record<string, string>>;
  importCheckpoints: Readonly<Record<string, string>>;
}

export type CreatorImportManifest = Omit<CreatorExportManifest, "checksum"> & { checksum: string };

/**
 * Creates a collision-safe import copy. Every portable record receives a new
 * UUID (the destination creator ID is supplied by the destination), and all
 * creator-owned relationships are rewritten through the same map. Provider
 * IDs, checksums, and object versions remain unchanged.
 */
export const remapCreatorExportForImport = (
  source: CreatorExportManifest,
  input: { targetCreatorId: string; uuid?: () => string; now?: string },
): { manifest: CreatorImportManifest; idMap: CreatorImportIdMap } => {
  const sourceManifest = validateCreatorExport(source);
  if (!input.targetCreatorId.trim()) throw new Error("A target creator ID is required.");
  const makeId = input.uuid ?? randomUUID;
  const mapRecords = <T extends { id: string }>(records: readonly T[]): Record<string, string> => Object.fromEntries(records.map((record) => [record.id, makeId()]));
  const idMap: CreatorImportIdMap = {
    creatorId: input.targetCreatorId,
    works: mapRecords(sourceManifest.works), assets: mapRecords(sourceManifest.assets), collections: mapRecords(sourceManifest.collections),
    publications: mapRecords(sourceManifest.publications), publicationIntents: mapRecords(sourceManifest.publicationIntents), processing: mapRecords(sourceManifest.processing),
    moderationEvidence: mapRecords(sourceManifest.moderationEvidence), moderationHolds: mapRecords(sourceManifest.moderationHolds), reviewCases: mapRecords(sourceManifest.reviewCases),
    auditEvents: mapRecords(sourceManifest.auditEvents), usageEvents: mapRecords(sourceManifest.usageEvents), integrationAccounts: mapRecords(sourceManifest.integrationAccounts),
    exportCheckpoints: mapRecords(sourceManifest.exportCheckpoints), importCheckpoints: mapRecords(sourceManifest.importCheckpoints),
  };
  const map = (table: Readonly<Record<string, string>>, id: string): string => table[id] ?? id;
  const creator = { ...sourceManifest.creator, id: input.targetCreatorId };
  const works = sourceManifest.works.map((item) => ({ ...item, id: map(idMap.works, item.id), creatorId: input.targetCreatorId }));
  const assets = sourceManifest.assets.map((item) => ({ ...item, id: map(idMap.assets, item.id), creatorId: input.targetCreatorId, workId: item.workId ? map(idMap.works, item.workId) : undefined }));
  const collections = sourceManifest.collections.map((item) => ({ ...item, id: map(idMap.collections, item.id), creatorId: input.targetCreatorId }));
  const publications = sourceManifest.publications.map((item) => ({ ...item, id: map(idMap.publications, item.id), workId: map(idMap.works, item.workId) }));
  const publicationIntents = sourceManifest.publicationIntents.map((item) => ({ ...item, id: map(idMap.publicationIntents, item.id), workId: map(idMap.works, item.workId) }));
  const processing = sourceManifest.processing.map((item) => ({ ...item, id: map(idMap.processing, item.id), assetId: map(idMap.assets, item.assetId) }));
  const moderationEvidence = sourceManifest.moderationEvidence.map((item) => ({ ...item, id: map(idMap.moderationEvidence, item.id), subjectId: map({ [sourceManifest.creator.id]: input.targetCreatorId, ...idMap.works, ...idMap.assets }, item.subjectId) }));
  const moderationHolds = sourceManifest.moderationHolds.map((item) => ({ ...item, id: map(idMap.moderationHolds, item.id), subjectId: map({ [sourceManifest.creator.id]: input.targetCreatorId, ...idMap.works, ...idMap.assets }, item.subjectId) }));
  const reviewCases = sourceManifest.reviewCases.map((item) => ({ ...item, id: map(idMap.reviewCases, item.id), subjectId: map({ [sourceManifest.creator.id]: input.targetCreatorId, ...idMap.works, ...idMap.assets }, item.subjectId) }));
  const auditEvents = sourceManifest.auditEvents.map((item) => ({ ...item, id: map(idMap.auditEvents, item.id), subjectId: item.subjectId ? map({ [sourceManifest.creator.id]: input.targetCreatorId, ...idMap.works, ...idMap.assets }, item.subjectId) : undefined }));
  const usageEvents = sourceManifest.usageEvents.map((item) => ({ ...item, id: map(idMap.usageEvents, item.id) }));
  const integrationAccounts = sourceManifest.integrationAccounts.map((item) => ({ ...item, id: map(idMap.integrationAccounts, item.id), creatorId: input.targetCreatorId }));
  const exportCheckpoints = sourceManifest.exportCheckpoints.map((item) => ({ ...item, id: map(idMap.exportCheckpoints, item.id), creatorId: input.targetCreatorId }));
  const importCheckpoints = sourceManifest.importCheckpoints.map((item) => ({ ...item, id: map(idMap.importCheckpoints, item.id), creatorId: input.targetCreatorId }));
  const objectInventory = sourceManifest.objectInventory.map((item) => ({ ...item, assetId: map(idMap.assets, item.assetId), key: item.key?.replace(`/creators/${sourceManifest.creator.id}/`, `/creators/${input.targetCreatorId}/`) }));
  const { checksum: _sourceChecksum, ...sourceUnsigned } = sourceManifest;
  const unsigned = { ...sourceUnsigned, creator, works, assets, collections, publications, publicationIntents, processing, moderationEvidence, moderationHolds, reviewCases, auditEvents, usageEvents, integrationAccounts, exportCheckpoints, importCheckpoints, objectInventory, exportedAt: input.now ?? sourceManifest.exportedAt };
  const manifest = { ...unsigned, checksum: exportChecksum(unsigned) };
  return { manifest, idMap };
};
