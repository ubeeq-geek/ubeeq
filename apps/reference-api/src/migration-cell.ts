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
    if (command.operation === "import") {
      const manifestObject = command.checkpoint.objectInventory?.find((object) => object.id === "migration-manifest");
      if (!manifestObject) throw new Error("Migration manifest object is missing from the verified inventory.");
      const stored = await input.storage.get({ bucket: manifestObject.destination.bucket, key: manifestObject.destination.key });
      const manifest = validateCreatorExport(JSON.parse(Buffer.from(stored.body).toString("utf8")));
      if (manifest.creator.id !== command.checkpoint.creatorId) throw new Error("Migration manifest creator does not match its checkpoint.");
      const home = { homeCellId: input.cellId, dataHomeRegion: input.region, dataHomeAssignedAt: command.checkpoint.createdAt, routingRevision: command.checkpoint.source.routingRevision + 1 };
      const clean = (value: any) => { const { revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...record } = value; return { ...record, instanceId: input.instanceId, ...home }; };
      const put = async (repository: any, value: any, key: string) => { if (!await repository.get(value.id)) await repository.create(clean(value), { idempotencyKey: `migration:${command.checkpoint.id}:${key}:${value.id}` }); };
      await put(input.repositories.creators, manifest.creator, "creator");
      for (const value of manifest.works) await put(input.repositories.works, value, "work");
      for (const value of manifest.collections) await put(input.repositories.collections, value, "collection");
      for (const value of manifest.assets) {
        const object = command.checkpoint.objectInventory?.find((candidate) => candidate.id === value.id);
        if (!object) throw new Error(`Migration object inventory is missing asset ${value.id}.`);
        const asset = value as any;
        await put(input.repositories.assets, { ...asset, storage: asset.storage ? { ...asset.storage, bucket: object.destination.bucket, key: object.destination.key, versionId: undefined } : asset.storage }, "asset");
      }
      for (const value of manifest.publications) await put(input.repositories.publications, value, "publication");
      for (const value of manifest.publicationIntents) await put(input.repositories.publicationIntents, value, "publication-intent");
      for (const value of manifest.moderationEvidence) await put(input.repositories.moderationEvidence, value, "evidence");
      for (const value of manifest.moderationHolds) await put(input.repositories.moderationHolds, value, "hold");
      for (const value of manifest.reviewCases) await put(input.repositories.reviewCases, value, "review");
      for (const value of manifest.auditEvents) await put(input.repositories.auditEvents, value, "audit");
      for (const value of manifest.usageEvents) await put(input.repositories.usageEvents, value, "usage");
      for (const value of manifest.integrationAccounts) await put(input.repositories.integrationAccounts, { ...value, health: "blocked", credentialReference: undefined }, "integration");
      return {};
    }
    if (command.operation === "enable" || command.operation === "rollback") {
      const action = command.operation === "enable" ? "regional_migration.destination_enabled" : "regional_migration.destination_rolled_back";
      const id = `${action}:${command.checkpoint.id}`;
      if (!await input.repositories.auditEvents.get(id)) await input.repositories.auditEvents.create({ id, instanceId: input.instanceId, homeCellId: input.cellId, dataHomeRegion: input.region, dataHomeAssignedAt: command.checkpoint.createdAt, routingRevision: command.checkpoint.source.routingRevision + 1, action, subjectId: command.checkpoint.creatorId, payload: { migrationId: command.checkpoint.id } } as any, { idempotencyKey: id });
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
