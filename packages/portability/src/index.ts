import { createHash } from "node:crypto";
import type { AssetRecord, CollectionRecord, CreatorRecord, PublicationRecord, WorkRecord } from "@ubeeq/persistence";

export const CREATOR_EXPORT_SCHEMA_VERSION = "1" as const;

export interface CreatorExportManifest {
  schemaVersion: typeof CREATOR_EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  creator: CreatorRecord;
  works: readonly WorkRecord[];
  assets: readonly AssetRecord[];
  collections: readonly CollectionRecord[];
  publications: readonly PublicationRecord[];
  secretsExcluded: true;
  checksum: string;
}

export interface ImportConflict { resource: "work" | "asset" | "collection"; id: string; reason: "id_exists" | "creator_mismatch"; }
export interface ImportPlan { valid: boolean; conflicts: readonly ImportConflict[]; itemCounts: { works: number; assets: number; collections: number; publications: number }; }

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
  return value;
};
export const stableJson = (value: unknown): string => JSON.stringify(canonicalize(value));
export const exportChecksum = (manifest: Omit<CreatorExportManifest, "checksum">): string => createHash("sha256").update(stableJson(manifest)).digest("hex");

export const createCreatorExport = (input: Omit<CreatorExportManifest, "schemaVersion" | "checksum" | "secretsExcluded">): CreatorExportManifest => {
  const manifest = { ...input, schemaVersion: CREATOR_EXPORT_SCHEMA_VERSION, secretsExcluded: true as const };
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
  const manifest: CreatorExportManifest = { schemaVersion: candidate.schemaVersion, exportedAt: candidate.exportedAt, creator: candidate.creator, works: candidate.works, assets: candidate.assets, collections: candidate.collections, publications: candidate.publications, secretsExcluded: candidate.secretsExcluded, checksum: candidate.checksum };
  if (manifest.schemaVersion !== CREATOR_EXPORT_SCHEMA_VERSION) throw new Error(`Unsupported export schema version: ${String(manifest.schemaVersion)}.`);
  if (!manifest.creator?.id || !Array.isArray(manifest.works) || !Array.isArray(manifest.assets) || !Array.isArray(manifest.collections) || !Array.isArray(manifest.publications)) throw new Error("Export manifest is missing required creator content arrays.");
  if (manifest.secretsExcluded !== true || containsSecret(manifest)) throw new Error("Export manifests must exclude credentials and secrets.");
  const { checksum: _checksum, ...unsigned } = manifest;
  if (!manifest.checksum || exportChecksum(unsigned) !== manifest.checksum) throw new Error("Export manifest checksum does not match its contents.");
  const creatorId = manifest.creator.id;
  if (manifest.works.some((work) => work.creatorId !== creatorId) || manifest.assets.some((asset) => asset.creatorId !== creatorId) || manifest.collections.some((collection) => collection.creatorId !== creatorId)) throw new Error("Export manifest contains records owned by another creator.");
  return manifest;
};

export const planCreatorImport = (manifest: CreatorExportManifest, input: { existingWorkIds: readonly string[]; existingAssetIds: readonly string[]; existingCollectionIds: readonly string[]; targetCreatorId: string }): ImportPlan => {
  const conflicts: ImportConflict[] = [];
  const addConflicts = (resource: ImportConflict["resource"], records: readonly { id: string; creatorId: string }[], existing: readonly string[]) => records.forEach((record) => {
    if (record.creatorId !== manifest.creator.id) conflicts.push({ resource, id: record.id, reason: "creator_mismatch" });
    else if (existing.includes(record.id)) conflicts.push({ resource, id: record.id, reason: "id_exists" });
  });
  addConflicts("work", manifest.works, input.existingWorkIds); addConflicts("asset", manifest.assets, input.existingAssetIds); addConflicts("collection", manifest.collections, input.existingCollectionIds);
  return { valid: conflicts.length === 0, conflicts, itemCounts: { works: manifest.works.length, assets: manifest.assets.length, collections: manifest.collections.length, publications: manifest.publications.length } };
};
