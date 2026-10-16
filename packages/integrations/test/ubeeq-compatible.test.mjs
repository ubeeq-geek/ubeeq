import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUbeeqPublicationMappings, availableUbeeqCapabilities, createUbeeqCompatibleCatalog,
  presetForDiscoveredService, requireSafePublicationActivation, resolveUbeeqIdempotentJob,
  ubeeqPublicationMappingKey, validateUbeeqDiscovery, UBEEQ_INVENTORY_PATH
} from "../dist/index.js";

const discovery = {
  instanceId: "instance-es-1", canonicalOrigin: "https://example.test", apiBaseUrl: "https://example.test/v1",
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
  assert.equal(resolveUbeeqIdempotentJob({ ...job, remoteResultId: "publication-1" }, job), "resume");
  assert.equal(resolveUbeeqIdempotentJob({ ...job, status: "completed", remoteResultId: "publication-1" }, job), "return_existing");
  assert.throws(() => resolveUbeeqIdempotentJob(job, { ...job, payloadFingerprint: "sha256:y" }), /reused/);
  assert.throws(() => resolveUbeeqIdempotentJob(job, { ...job, remoteAccountId: "other" }), /reused/);
});

test("premium publication never falls back to public and activation waits for readiness", () => {
  assert.throws(() => requireSafePublicationActivation({ requestedAccess: "premium", supportedAccess: ["public"], assetsReady: true, accessSettingsReady: true, supportsStagingOrDraft: true }), /does not support/);
  assert.throws(() => requireSafePublicationActivation({ requestedAccess: "premium", supportedAccess: ["premium"], assetsReady: true, accessSettingsReady: false, supportsStagingOrDraft: true }), /cannot be activated/);
  assert.doesNotThrow(() => requireSafePublicationActivation({ requestedAccess: "premium", supportedAccess: ["premium"], assetsReady: true, accessSettingsReady: true, supportsStagingOrDraft: true }));
});


test('rejects malformed discovery, spoofed origins, and special network addresses', () => {
  for (const input of [null, [], {}, { ...discovery, instanceId: 7 }, { ...discovery, capabilities: 'inventory.read' },
    { ...discovery, protocolVersions: ['1.garbage'] }, { ...discovery, extensions: { x: {} } }])
    assert.throws(() => validateUbeeqDiscovery(input, { requestedOrigin: 'https://example.test' }));
  for (const hostname of ['0.0.0.0', '127.1', 'localhost.', 'a.localhost', '100.64.0.1', '198.18.0.1',
    '[::ffff:127.0.0.1]', '[::ffff:a00:1]', '[fe90::1]', '[ff02::1]', '[2001:db8::1]'])
    assert.throws(() => validateUbeeqDiscovery({ ...discovery, apiBaseUrl: `https://${hostname}/api` }, { requestedOrigin: 'https://example.test' }), /Private-network/);
  assert.throws(() => validateUbeeqDiscovery({ ...discovery, canonicalOrigin: 'https://attacker.test' }, { requestedOrigin: 'https://example.test' }), /Canonical/);
  assert.throws(() => validateUbeeqDiscovery({ ...discovery, authorizationEndpoint: 'https://attacker.test/auth' }, { requestedOrigin: 'https://example.test' }), /approval/);
  assert.throws(() => validateUbeeqDiscovery({ ...discovery, canonicalOrigin: 'https://example.test/path' }, { requestedOrigin: 'https://example.test' }), /origins/);
  const validated = validateUbeeqDiscovery({ ...discovery, capabilities: ['inventory.read', 'future.read'], authorizationEndpoint: 'https://auth.example.test/authorize' },
    { requestedOrigin: 'https://example.test', trustedEndpointOrigins: ['https://auth.example.test'] });
  assert.deepEqual(validated.capabilities, ['inventory.read']);
  assert.equal(validateUbeeqDiscovery({ ...discovery, apiBaseUrl: 'https://fc.example.test/api' }, { requestedOrigin: 'https://example.test', trustedEndpointOrigins: ['https://fc.example.test'] }).instanceId, discovery.instanceId);
  assert.throws(() => validateUbeeqDiscovery(discovery, { requestedOrigin: 'https://example.test', resolvedAddresses: ['not-an-ip'] }), /valid IP/);
});
test('idempotency includes the connection and direction and resumes unfinished remote results', () => {
  for (const change of [{ connectionId: 'other' }, { direction: 'import' }])
    assert.throws(() => resolveUbeeqIdempotentJob(job, { ...job, ...change }), /reused/);
  assert.equal(resolveUbeeqIdempotentJob({ ...job, status: 'partially_completed', remoteResultId: 'draft' }, job), 'resume');
});
test('activation requires actual boolean readiness flags at runtime', () => {
  const ready = { requestedAccess: 'private', supportedAccess: ['private'], assetsReady: true, accessSettingsReady: true, supportsStagingOrDraft: true };
  for (const field of ['assetsReady', 'accessSettingsReady', 'supportsStagingOrDraft'])
    assert.throws(() => requireSafePublicationActivation({ ...ready, [field]: 'false' }));
});

test('mapping guards reject empty identities and unknown lifecycle states', () => {
  const mapping = { instanceId: 'i', remoteAccountId: 'a', remoteSpaceId: 's', localPublicationId: 'p', remotePublicationId: 'r', remoteRevision: '1', lifecycle: 'active' };
  assert.throws(() => assertUbeeqPublicationMappings([{ ...mapping, remoteAccountId: '' }]), /mapping/);
  assert.throws(() => assertUbeeqPublicationMappings([{ ...mapping, lifecycle: 'unknown' }]), /lifecycle/);
});

test('normalized discovery base and relative endpoint paths preserve deployment API prefixes', () => {
  const validated = validateUbeeqDiscovery(discovery, { requestedOrigin: 'https://example.test' });
  assert.equal(new URL(UBEEQ_INVENTORY_PATH, validated.apiBaseUrl).href, 'https://example.test/v1/inventory');
  assert.throws(() => validateUbeeqDiscovery({ ...discovery, apiBaseUrl: 'https://example.test/v1?token=secret' }, { requestedOrigin: 'https://example.test' }), /query/);
});
