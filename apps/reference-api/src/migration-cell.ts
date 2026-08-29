import { createHash } from "node:crypto";
import { createCreatorExport, validateCreatorExport } from "@ubeeq/portability";
import type { UbeeqRepositories } from "@ubeeq/persistence";
import type { ObjectStorage, StoredObject } from "@ubeeq/storage";
import type { MigrationCellCommand, MigrationCellCommandResult, MigrationCellEndpoint } from "@ubeeq/deployment-platform";

type StoredLocation = { bucket?: string; key?: string; versionId?: string; byteLength?: number };
type StoredAsset = { id: string; creatorId: string; checksum: string; objectVersion: string; storage?: StoredLocation; originalStorage?: StoredLocation; [key: string]: unknown };
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
    if ((["source_hold", "source_release", "export", "retire"] as const).includes(command.operation as "source_hold") && !source) throw new Error("Migration source command was sent to a foreign cell.");
    if ((["import", "enable", "rollback"] as const).includes(command.operation as "import") && !destination) throw new Error("Migration destination command was sent to a foreign cell.");
    if (command.operation === "source_hold") {
      const creator = (await all(input.repositories.creators)).find((value: any) => value.id === command.checkpoint.creatorId) as any;
      if (!creator || creator.homeCellId !== input.cellId) throw new Error("Migration creator is not owned by this source cell.");
      const exists = (await all(input.repositories.moderationHolds)).find((hold: any) => hold.subjectId === command.checkpoint.creatorId && hold.reason === `migration:${command.checkpoint.id}` && hold.state === "active");
      if (!exists) await input.repositories.moderationHolds.create({ id: `migration-hold:${command.checkpoint.id}`, instanceId: input.instanceId, homeCellId: creator.homeCellId, dataHomeRegion: creator.dataHomeRegion, dataHomeAssignedAt: creator.dataHomeAssignedAt, routingRevision: creator.routingRevision, subjectType: "creator", subjectId: command.checkpoint.creatorId, state: "active", reason: `migration:${command.checkpoint.id}` } as any, { idempotencyKey: `migration-hold:${command.checkpoint.id}` });
      return {};
    }
    if (command.operation === "source_release") {
      const hold = (await all(input.repositories.moderationHolds)).find((value: any) => value.subjectId === command.checkpoint.creatorId && value.reason === `migration:${command.checkpoint.id}`);
      if (hold?.state === "active") await input.repositories.moderationHolds.update(hold.id, hold.revision, { state: "released" });
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
        const original = command.checkpoint.objectInventory?.find((candidate) => candidate.id === `${value.id}:original`);
        if (!object) throw new Error(`Migration object inventory is missing asset ${value.id}.`);
        const asset = value as any;
        if (asset.originalStorage && !original) throw new Error(`Migration object inventory is missing the original for asset ${value.id}.`);
        await put(input.repositories.assets, {
          ...asset,
          storage: asset.storage ? { ...asset.storage, bucket: object.destination.bucket, key: object.destination.key, versionId: undefined } : asset.storage,
          originalStorage: asset.originalStorage ? { ...asset.originalStorage, bucket: original!.destination.bucket, key: original!.destination.key, versionId: undefined } : asset.originalStorage,
        }, "asset");
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
    if (command.operation === "retire") {
      const removeOwned = async (repository: any, predicate: (value: any) => boolean) => { for (const value of (await all(repository) as any[])) if (predicate(value)) await repository.remove(value.id, value.revision, { idempotencyKey: `migration-retire:${command.checkpoint.id}:${value.id}` }); };
      const creatorId = command.checkpoint.creatorId;
      const works = (await all(input.repositories.works) as any[]).filter((value) => value.creatorId === creatorId);
      const assets = (await all(input.repositories.assets) as unknown as readonly StoredAsset[]).filter((value) => value.creatorId === creatorId);
      const collections = (await all(input.repositories.collections) as any[]).filter((value) => value.creatorId === creatorId);
      const integrations = (await all(input.repositories.integrationAccounts) as any[]).filter((value) => value.creatorId === creatorId);
      const workIds = new Set(works.map((value) => value.id)), assetIds = new Set(assets.map((value) => value.id)), collectionIds = new Set(collections.map((value) => value.id)), integrationIds = new Set(integrations.map((value) => value.id));
      const publicationIds = new Set((await all(input.repositories.publications) as any[]).filter((value) => workIds.has(value.workId)).map((value) => value.id));
      const subjectIds = new Set([creatorId, ...workIds, ...assetIds, ...collectionIds]);
      // Object removal is intentionally migration-only. The normal cell path
      // never calls this operation or receives a foreign object location.
      for (const asset of assets) for (const location of [asset.storage, asset.originalStorage]) {
        if (location?.bucket && location.key) await input.storage.remove({ bucket: location.bucket, key: location.key, versionId: location.versionId }).catch(() => undefined);
      }
      await removeOwned(input.repositories.workMemberships, (value) => workIds.has(value.workId) || collectionIds.has(value.collectionId));
      await removeOwned(input.repositories.reconciliationSnapshots, (value) => publicationIds.has(value.publicationId));
      await removeOwned(input.repositories.syncCursors, (value) => integrationIds.has(value.integrationAccountId));
      await removeOwned(input.repositories.integrationJobs, (value) => integrationIds.has(value.integrationAccountId));
      await removeOwned(input.repositories.publicationIntents, (value) => workIds.has(value.workId));
      await removeOwned(input.repositories.publications, (value) => workIds.has(value.workId));
      await removeOwned(input.repositories.moderationEvidence, (value) => subjectIds.has(value.subjectId));
      await removeOwned(input.repositories.moderationHolds, (value) => subjectIds.has(value.subjectId));
      await removeOwned(input.repositories.reviewCases, (value) => subjectIds.has(value.subjectId));
      await removeOwned(input.repositories.usageEvents, (value) => value.accountId === creatorId);
      await removeOwned(input.repositories.creditLots, (value) => value.accountId === creatorId);
      await removeOwned(input.repositories.creditReservations, (value) => value.accountId === creatorId);
      await removeOwned(input.repositories.balances, (value) => value.accountId === creatorId);
      await removeOwned(input.repositories.exportManifests, (value) => value.creatorId === creatorId);
      await removeOwned(input.repositories.importCheckpoints, (value) => value.creatorId === creatorId);
      await removeOwned(input.repositories.integrationAccounts, (value) => value.creatorId === creatorId);
      await removeOwned(input.repositories.assets, (value) => value.creatorId === creatorId);
      await removeOwned(input.repositories.collections, (value) => value.creatorId === creatorId);
      await removeOwned(input.repositories.works, (value) => value.creatorId === creatorId);
      const creator = await input.repositories.creators.get(creatorId);
      if (creator) await input.repositories.creators.remove(creator.id, creator.revision, { idempotencyKey: `migration-retire:${command.checkpoint.id}:creator` });
      // Audit records are intentionally retained in the source cell. They are
      // immutable operator evidence, and retention is disclosed by deployment
      // policy rather than silently discarded during a data migration.
      const eventId = `regional_migration.source_retired:${command.checkpoint.id}`;
      if (!await input.repositories.auditEvents.get(eventId)) await input.repositories.auditEvents.create({ id: eventId, instanceId: input.instanceId, homeCellId: input.cellId, dataHomeRegion: input.region, dataHomeAssignedAt: command.checkpoint.createdAt, routingRevision: command.checkpoint.source.routingRevision, action: "regional_migration.source_retired", subjectId: creatorId, payload: { migrationId: command.checkpoint.id, auditRetention: "deployment_policy" } } as any, { idempotencyKey: eventId });
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
    const manifestObject: StoredObject = { bucket: input.cellId, key: manifestKey, contentType: "application/json", byteLength: body.byteLength, checksum, scope: "private" };
    await input.storage.put({ object: manifestObject, body });
    const inventoryEntry = (id: string, location: StoredLocation, asset: StoredAsset) => {
      if (!location.key) throw new Error(`Migration asset ${asset.id} has no stored object key.`);
      return {
        id,
        source: { bucket: location.bucket ?? input.cellId, key: location.key, versionId: location.versionId },
        destination: { bucket: command.destinationBucket!, key: location.key.replace(`cells/${input.cellId}/`, `cells/${command.checkpoint.destination.cellId}/`) },
        checksum: asset.checksum,
        byteLength: location.byteLength ?? 0,
      };
    };
    const assetObjects = assets.flatMap((asset) => {
      if (!asset.storage) throw new Error(`Migration asset ${asset.id} has no active storage location.`);
      const active = inventoryEntry(asset.id, asset.storage, asset);
      if (!asset.originalStorage || asset.originalStorage.key === asset.storage.key) return [active];
      return [active, inventoryEntry(`${asset.id}:original`, asset.originalStorage, asset)];
    });
    const objects = [{ id: "migration-manifest", source: { bucket: input.cellId, key: manifestKey, versionId: manifestObject.versionId }, destination: { bucket: command.destinationBucket!, key: `cells/${command.checkpoint.destination.cellId}/migrations/${command.checkpoint.id}/creator-export.json` }, checksum, byteLength: body.byteLength }, ...assetObjects];
    return { manifestChecksum: manifest.checksum, objectInventory: objects };
  }
});
