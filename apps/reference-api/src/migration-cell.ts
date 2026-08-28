import { createHash } from "node:crypto";
import { createCreatorExport, validateCreatorExport } from "@ubeeq/portability";
import type { UbeeqRepositories } from "@ubeeq/persistence";
import type { ObjectStorage } from "@ubeeq/storage";
import type { MigrationCellCommand, MigrationCellCommandResult, MigrationCellEndpoint } from "@ubeeq/deployment-platform";

type StoredAsset = { id: string; creatorId: string; checksum: string; objectVersion: string; storage?: { bucket?: string; key?: string; versionId?: string; byteLength?: number }; [key: string]: unknown };
const all = async <T>(repository: { list(input: { limit: number; cursor?: string }): Promise<{ items: readonly T[]; nextCursor?: string }> }): Promise<readonly T[]> => { const values: T[] = []; let cursor: string | undefined; do { const page = await repository.list({ limit: 100, cursor }); values.push(...page.items); cursor = page.nextCursor; } while (cursor); return values; };

/**
 * Private regional command endpoint. It validates the declared cell before
 * reading any data. Source export writes an immutable manifest object that is
 * transferred as part of the explicit migration inventory; it never sends
 * secrets or metadata through the control plane.
 */
export const createMigrationCellEndpoint = (input: { cellId: string; region: string; instanceId: string; repositories: UbeeqRepositories; storage: ObjectStorage }): MigrationCellEndpoint => ({
  async execute(command: MigrationCellCommand): Promise<MigrationCellCommandResult> {
    const source = command.checkpoint.source.homeCellId === input.cellId, destination = command.checkpoint.destination.cellId === input.cellId;
    if ((["source_hold", "export", "retire"] as const).includes(command.operation as "source_hold") && !source) throw new Error("Migration source command was sent to a foreign cell.");
    if ((["import", "enable", "rollback"] as const).includes(command.operation as "import") && !destination) throw new Error("Migration destination command was sent to a foreign cell.");
    if (command.operation === "source_hold") {
      const exists = (await all(input.repositories.moderationHolds)).find((hold: any) => hold.subjectId === command.checkpoint.creatorId && hold.reason === `migration:${command.checkpoint.id}` && hold.state === "active");
      if (!exists) await input.repositories.moderationHolds.create({ id: `migration-hold:${command.checkpoint.id}`, instanceId: input.instanceId, homeCellId: input.cellId, dataHomeRegion: input.region, dataHomeAssignedAt: command.checkpoint.createdAt, routingRevision: command.checkpoint.source.routingRevision, subjectType: "creator", subjectId: command.checkpoint.creatorId, state: "active", reason: `migration:${command.checkpoint.id}` } as any, { idempotencyKey: `migration-hold:${command.checkpoint.id}` });
      return {};
    }
    if (command.operation !== "export") return {};
    const creator = (await all(input.repositories.creators)).find((value: any) => value.id === command.checkpoint.creatorId) as any;
    if (!creator || creator.homeCellId !== input.cellId) throw new Error("Migration creator is not owned by this source cell.");
    const works = (await all(input.repositories.works)).filter((value: any) => value.creatorId === creator.id);
    const assets = (await all(input.repositories.assets)).filter((value: any) => value.creatorId === creator.id) as unknown as StoredAsset[];
    const collections = (await all(input.repositories.collections)).filter((value: any) => value.creatorId === creator.id);
    const workIds = new Set(works.map((value: any) => value.id)), subjectIds = new Set([creator.id, ...works.map((value: any) => value.id), ...assets.map((value) => value.id)]);
    const pick = async (repository: any, predicate: (value: any) => boolean) => (await all(repository)).filter(predicate);
    const manifest = createCreatorExport(({ exportedAt: new Date().toISOString(), creator, works, assets: assets as any, collections, publications: await pick(input.repositories.publications, (value) => workIds.has(value.workId)), publicationIntents: await pick(input.repositories.publicationIntents, (value) => workIds.has(value.workId)), processing: assets.map((asset: any) => ({ id: `asset-processing:${asset.id}`, assetId: asset.id, homeCellId: creator.homeCellId, dataHomeRegion: creator.dataHomeRegion, dataHomeAssignedAt: creator.dataHomeAssignedAt, routingRevision: creator.routingRevision, state: asset.status })), moderationEvidence: await pick(input.repositories.moderationEvidence, (value) => subjectIds.has(value.subjectId)), moderationHolds: await pick(input.repositories.moderationHolds, (value) => subjectIds.has(value.subjectId)), reviewCases: await pick(input.repositories.reviewCases, (value) => subjectIds.has(value.subjectId)), auditEvents: await pick(input.repositories.auditEvents, (value) => subjectIds.has(value.subjectId)), usageEvents: await pick(input.repositories.usageEvents, (value) => value.accountId === creator.id), integrationAccounts: (await pick(input.repositories.integrationAccounts, (value) => value.creatorId === creator.id)).map(({ credentialReference: _secret, ...value }: any) => ({ ...value, credentialExcluded: true })), exportCheckpoints: await pick(input.repositories.exportManifests, (value) => value.creatorId === creator.id), importCheckpoints: await pick(input.repositories.importCheckpoints, (value) => value.creatorId === creator.id), objectInventory: assets.map((asset) => ({ assetId: asset.id, key: asset.storage?.key, versionId: asset.storage?.versionId ?? asset.objectVersion, checksum: asset.checksum, byteLength: asset.storage?.byteLength, transferState: "manifest_only" as const })) }) as any);
    validateCreatorExport(manifest);
    const body = Buffer.from(JSON.stringify(manifest)), checksum = createHash("sha256").update(body).digest("hex"), manifestKey = `cells/${input.cellId}/migrations/${command.checkpoint.id}/creator-export.json`;
    await input.storage.put({ object: { bucket: input.cellId, key: manifestKey, contentType: "application/json", byteLength: body.byteLength, checksum, scope: "private" }, body });
    const objects = [{ id: "migration-manifest", source: { bucket: input.cellId, key: manifestKey }, destination: { bucket: command.destinationBucket!, key: `cells/${command.checkpoint.destination.cellId}/migrations/${command.checkpoint.id}/creator-export.json` }, checksum, byteLength: body.byteLength }, ...assets.map((asset) => ({ id: asset.id, source: { bucket: asset.storage?.bucket ?? input.cellId, key: asset.storage!.key!, versionId: asset.storage?.versionId }, destination: { bucket: command.destinationBucket!, key: asset.storage!.key!.replace(`cells/${input.cellId}/`, `cells/${command.checkpoint.destination.cellId}/`) }, checksum: asset.checksum, byteLength: asset.storage?.byteLength ?? 0 }))];
    return { manifestChecksum: manifest.checksum, objectInventory: objects };
  }
});
