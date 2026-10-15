import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUbeeqPublicationMappings, availableUbeeqCapabilities, createUbeeqCompatibleCatalog,
  presetForDiscoveredService, requireSafePublicationActivation, resolveUbeeqIdempotentJob,
  ubeeqPublicationMappingKey, validateUbeeqDiscovery
} from "../dist/index.js";

const discovery = {
  instanceId: "instance-es-1", canonicalOrigin: "https://example.test", apiBaseUrl: "https://api.example.test/v1",
  authorizationEndpoint: "https://example.test/oauth/authorize", protocolVersions: ["1.0"], service: "service-a",
  capabilities: ["inventory.read", "publications.create"]
};

test("three catalog choices use one connector and generic discovery recognizes verified presets", () => {
  const catalog = createUbeeqCompatibleCatalog([
    { id: "service-a", label: "Service A", setup: "official_endpoint" },
    { id: "service-b", label: "Service B", setup: "official_endpoint" }
  ]);
  assert.deepEqual(catalog.map(({ id }) => id), ["ubeeq-compatible", "service-a", "service-b"]);
  assert.equal(new Set(catalog.map(({ connectorFamily }) => connectorFamily)).size, 1);
  assert.equal(presetForDiscoveredService("ubeeq-compatible", "service-a"), "service-a");
  assert.equal(presetForDiscoveredService("service-b", "service-a"), "service-b");
  assert.throws(() => createUbeeqCompatibleCatalog([{ id: "ubeeq-compatible", label: "Duplicate", setup: "official_endpoint" }]), /unique/);
});

test("discovery negotiates versions and rejects unsafe managed-host endpoints", () => {
  assert.equal(validateUbeeqDiscovery(discovery, { requestedOrigin: "https://example.test", production: true }).instanceId, "instance-es-1");
  assert.throws(() => validateUbeeqDiscovery({ ...discovery, protocolVersions: ["2.0"] }, { requestedOrigin: "https://example.test" }), /Unsupported/);
  assert.throws(() => validateUbeeqDiscovery({ ...discovery, apiBaseUrl: "http://127.0.0.1/api" }, { requestedOrigin: "https://example.test" }), /Private-network/);
  assert.throws(() => validateUbeeqDiscovery(discovery, { requestedOrigin: "https://example.test", resolvedAddresses: ["169.254.169.254"] }), /private-network/);
  assert.throws(() => validateUbeeqDiscovery({ ...discovery, authorizationEndpoint: "https://user:secret@example.test/auth" }, { requestedOrigin: "https://example.test" }), /credentials/);
});

test("capabilities are the intersection of protocol, host, and grant", () => {
  assert.deepEqual(availableUbeeqCapabilities(
    ["inventory.read", "publications.create", "collections.write"],
    ["inventory.read", "publications.create"], ["inventory.read"]
  ), ["inventory.read"]);
});

test("publication identity supports sibling copies while protecting each active mapping", () => {
  const base = { instanceId: "i", remoteAccountId: "a", remoteSpaceId: "s", remoteWorkId: "rw", remoteRevision: "1", lifecycle: "active" };
  const mappings = [
    { ...base, localPublicationId: "preview", remotePublicationId: "remote-preview" },
    { ...base, localPublicationId: "premium", remotePublicationId: "remote-premium" },
    { ...base, localPublicationId: "collection", remotePublicationId: "remote-collection" },
    { ...base, localPublicationId: "volume", remotePublicationId: "remote-volume" }
  ];
  assert.doesNotThrow(() => assertUbeeqPublicationMappings(mappings));
  assert.notEqual(ubeeqPublicationMappingKey(mappings[0]), ubeeqPublicationMappingKey(mappings[1]));
  assert.throws(() => assertUbeeqPublicationMappings([...mappings, { ...mappings[0], remotePublicationId: "other" }]), /already exists/);
  assert.throws(() => assertUbeeqPublicationMappings([...mappings, { ...mappings[0], localPublicationId: "other" }]), /more than one/);
});

const job = { jobId: "j", connectionId: "c", instanceId: "i", remoteAccountId: "a", remoteSpaceId: "s",
  direction: "publish", operation: "publication_create", idempotencyKey: "stable", payloadFingerprint: "sha256:x", status: "running" };

test("ambiguous creates resume and completed remote results are not duplicated", () => {
  assert.equal(resolveUbeeqIdempotentJob(undefined, job), "submit");
  assert.equal(resolveUbeeqIdempotentJob(job, job), "resume");
  assert.equal(resolveUbeeqIdempotentJob({ ...job, remoteResultId: "publication-1" }, job), "return_existing");
  assert.throws(() => resolveUbeeqIdempotentJob(job, { ...job, payloadFingerprint: "sha256:y" }), /reused/);
  assert.throws(() => resolveUbeeqIdempotentJob(job, { ...job, remoteAccountId: "other" }), /reused/);
});

test("premium publication never falls back to public and activation waits for readiness", () => {
  assert.throws(() => requireSafePublicationActivation({ requestedAccess: "premium", supportedAccess: ["public"], assetsReady: true, accessSettingsReady: true, supportsStagingOrDraft: true }), /does not support/);
  assert.throws(() => requireSafePublicationActivation({ requestedAccess: "premium", supportedAccess: ["premium"], assetsReady: true, accessSettingsReady: false, supportsStagingOrDraft: true }), /cannot be activated/);
  assert.doesNotThrow(() => requireSafePublicationActivation({ requestedAccess: "premium", supportedAccess: ["premium"], assetsReady: true, accessSettingsReady: true, supportsStagingOrDraft: true }));
});
