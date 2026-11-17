import assert from "node:assert/strict";
import test from "node:test";
import { createCreatorExport, creatorAssetObjectInventory, exportChecksum, planCreatorImport, remapCreatorExportForImport, validateCreatorExport } from "../dist/index.js";

const creator = { id: "creator-1", instanceId: "source", homeCellId: "cell-a", dataHomeRegion: "eu-west", dataHomeAssignedAt: "2026-01-01T00:00:00.000Z", routingRevision: 1, handle: "source", displayName: "Source", revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
test('encoded output inventory retains actual hashes, every alias and immutable originals through remapping',()=>{
  const location=(name,checksum,scope='private')=>({bucket:'source-bucket',key:`cells/cell-a/creators/${creator.id}/${name}`,versionId:name+'-physical-version',checksum:checksum.repeat(64),byteLength:20,contentType:'audio/mpeg',scope});
  const original=location('original','a'),storage=location('playback','b','public'),poster=location('poster','c');
  const asset={...creator,id:'asset',creatorId:creator.id,mimeType:'audio/wav',deliveryMimeType:'audio/mpeg',checksum:original.checksum,objectVersion:'logical-source',status:'ready',storage,originalStorage:original,
    processedRenditions:[{id:'playback',sourceVersionId:'logical-source',role:'preview',storage},{id:'poster',sourceVersionId:'logical-source',role:'poster',storage:poster},{id:'alias',sourceVersionId:'logical-source',role:'poster',storage:poster}]};
  const inventory=creatorAssetObjectInventory(asset);assert.equal(inventory.checksum,storage.checksum);assert.equal(inventory.objects.length,4);
  const manifest=createCreatorExport({exportedAt:creator.createdAt,creator,works:[],assets:[asset],collections:[],publications:[],publicationIntents:[],processing:[],moderationEvidence:[],moderationHolds:[],reviewCases:[],auditEvents:[],usageEvents:[],integrationAccounts:[],exportCheckpoints:[],importCheckpoints:[],objectInventory:[inventory]});
  assert.equal(validateCreatorExport(manifest).checksum,manifest.checksum);
  const mapped=remapCreatorExportForImport(manifest,{targetCreatorId:'target'}).manifest;
  assert.equal(validateCreatorExport(mapped).checksum,mapped.checksum);assert.ok(mapped.objectInventory[0].objects.every(value=>value.key.includes('/creators/target/')));
  const resign=value=>{const {checksum,...unsigned}=value;return {...unsigned,checksum:exportChecksum(unsigned)};};
  for(const objects of [undefined,inventory.objects.slice(0,2),inventory.objects.map(value=>({...value,checksum:asset.checksum}))])
    assert.throws(()=>validateCreatorExport(resign({...manifest,objectInventory:[{...inventory,objects}]})),/output inventory/);
});
test("validates portable exports and reports deterministic import conflicts", () => {
  const manifest = createCreatorExport({ exportedAt: "2026-01-01T00:00:00.000Z", creator, works: [{ id: "work-1", instanceId: "source", homeCellId: "cell-a", dataHomeRegion: "eu-west", dataHomeAssignedAt: creator.dataHomeAssignedAt, routingRevision: 1, creatorId: creator.id, title: "Work", status: "draft", revision: 1, createdAt: creator.createdAt, updatedAt: creator.updatedAt }], assets: [], collections: [], publications: [], publicationIntents: [], processing: [], moderationEvidence: [], moderationHolds: [], reviewCases: [], auditEvents: [], usageEvents: [], integrationAccounts: [], exportCheckpoints: [], importCheckpoints: [], objectInventory: [] });
  assert.equal(validateCreatorExport(manifest).checksum, manifest.checksum);
  assert.deepEqual(planCreatorImport(manifest, { targetCreatorId: "target", existingWorkIds: ["work-1"], existingAssetIds: [], existingCollectionIds: [] }).conflicts, [{ resource: "work", id: "work-1", reason: "id_exists" }]);
  assert.throws(() => validateCreatorExport({ ...manifest, checksum: "invalid" }), /checksum/);
  const resign = (value) => { const { checksum: _checksum, ...unsigned } = value; return { ...unsigned, checksum: exportChecksum(unsigned) }; };
  assert.throws(() => validateCreatorExport(resign({ ...manifest, publications: [{ id: "publication-1", instanceId: "source", homeCellId: "cell-a", dataHomeRegion: "eu-west", dataHomeAssignedAt: creator.dataHomeAssignedAt, routingRevision: 1, workId: "missing", destination: "local", status: "live", revision: 1, createdAt: creator.createdAt, updatedAt: creator.updatedAt }] })), /dangling/);
  assert.throws(() => validateCreatorExport(resign({ ...manifest, exclusions: ["credentials"] })), /exclusions/);
  assert.throws(() => validateCreatorExport(resign({ ...manifest, works: [...manifest.works, manifest.works[0]] })), /duplicate/);
});

test("remaps every portable ID and rewrites relationships for a new target creator", () => {
  const work = { id: "work-1", instanceId: "source", homeCellId: "cell-a", dataHomeRegion: "eu-west", dataHomeAssignedAt: creator.dataHomeAssignedAt, routingRevision: 1, creatorId: creator.id, title: "Work", status: "draft", revision: 1, createdAt: creator.createdAt, updatedAt: creator.updatedAt };
  const asset = { id: "asset-1", instanceId: "source", homeCellId: "cell-a", dataHomeRegion: "eu-west", dataHomeAssignedAt: creator.dataHomeAssignedAt, routingRevision: 1, creatorId: creator.id, workId: work.id, mimeType: "image/jpeg", checksum: "a".repeat(64), objectVersion: "v1", status: "ready", revision: 1, createdAt: creator.createdAt, updatedAt: creator.updatedAt };
  const manifest = createCreatorExport({ exportedAt: creator.createdAt, creator, works: [work], assets: [asset], collections: [], publications: [{ id: "publication-1", instanceId: "source", homeCellId: "cell-a", dataHomeRegion: "eu-west", dataHomeAssignedAt: creator.dataHomeAssignedAt, routingRevision: 1, workId: work.id, destination: "local", status: "live", revision: 1, createdAt: creator.createdAt, updatedAt: creator.updatedAt }], publicationIntents: [], processing: [], moderationEvidence: [{ id: "evidence-1", instanceId: "source", homeCellId: "cell-a", dataHomeRegion: "eu-west", dataHomeAssignedAt: creator.dataHomeAssignedAt, routingRevision: 1, subjectType: "work", subjectId: work.id, source: "test", payload: {}, revision: 1, createdAt: creator.createdAt, updatedAt: creator.updatedAt }], moderationHolds: [], reviewCases: [], auditEvents: [], usageEvents: [], integrationAccounts: [], exportCheckpoints: [], importCheckpoints: [], objectInventory: [{ assetId: asset.id, versionId: "v1", checksum: asset.checksum, key: `cells/cell-a/creators/${creator.id}/asset-1`, transferState: "manifest_only" }] });
  const ids = ["new-work", "new-asset", "new-pub", "new-evidence"];
  const result = remapCreatorExportForImport(manifest, { targetCreatorId: "target-creator", uuid: () => ids.shift() ?? "unexpected" });
  assert.equal(result.manifest.creator.id, "target-creator");
  assert.equal(result.manifest.works[0].id, "new-work");
  assert.equal(result.manifest.assets[0].id, "new-asset");
  assert.equal(result.manifest.assets[0].workId, "new-work");
  assert.equal(result.manifest.publications[0].workId, "new-work");
  assert.equal(result.manifest.moderationEvidence[0].subjectId, "new-work");
  assert.match(result.manifest.objectInventory[0].key, /target-creator/);
  assert.equal(validateCreatorExport(result.manifest).checksum, result.manifest.checksum);
});
