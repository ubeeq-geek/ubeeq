import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveUserAgent,
  resolveConnectorCredentials,
  evaluateInstagramEligibility,
  evaluateFanvueRightsEligibility,
  PatreonAccessPolicy,
  prioritizeExternalSyncJobs,
  PersistentMessagingWorker,
  UBEEQ_REDDIT_TABLE,
  UBEEQ_TUMBLR_RECORDS_TABLE,
  UBEEQ_VIMEO_TABLE,
  UBEEQ_PATREON_TABLE,
  UBEEQ_SMUGMUG_TABLE,
} from '../dist/index.js';

test('resolveUserAgent defaults to Ubeeq/1.0 and respects configured override', () => {
  assert.equal(resolveUserAgent(), 'Ubeeq/1.0');
  assert.equal(resolveUserAgent({}), 'Ubeeq/1.0');
  assert.equal(resolveUserAgent({ instanceUserAgent: 'CustomInstance/2.0' }), 'CustomInstance/2.0');
});

test('resolveConnectorCredentials queries port and raises explicit error when unconfigured', async () => {
  const dummyPort = {
    mode: 'byo_credentials',
    async resolveOAuthClient(provider, creatorId) {
      if (provider === 'reddit') {
        return {
          clientId: 'cid-1',
          clientSecret: 'csec-1',
          redirectUri: 'https://app.test/oauth/reddit',
          credentialSource: 'operator_env',
        };
      }
      return null;
    },
  };

  const creds = await resolveConnectorCredentials(dummyPort, 'reddit', 'creator-1');
  assert.equal(creds.clientId, 'cid-1');
  assert.equal(creds.credentialSource, 'operator_env');

  await assert.rejects(
    async () => resolveConnectorCredentials(dummyPort, 'unknown-provider', 'creator-1'),
    (err) => err.message.includes("No credentials configured for provider 'unknown-provider'")
  );
});

test('neutral SQLite table constants match ubeeq_* schema', () => {
  assert.equal(UBEEQ_REDDIT_TABLE, 'ubeeq_reddit_records');
  assert.equal(UBEEQ_TUMBLR_RECORDS_TABLE, 'ubeeq_tumblr_records');
  assert.equal(UBEEQ_VIMEO_TABLE, 'ubeeq_vimeo');
  assert.equal(UBEEQ_PATREON_TABLE, 'ubeeq_patreon_state');
  assert.equal(UBEEQ_SMUGMUG_TABLE, 'ubeeq_smugmug_state');
});

test('evaluateInstagramEligibility validates PlatformManagedApp mode and conservative policy', () => {
  const baseConnection = {
    connectionId: 'conn-ig-1',
    ownerUserId: 'user-1',
    creatorId: 'creator-1',
    mode: 'PlatformManagedApp',
    remoteProfessionalAccountId: 'prof-1',
    accountType: 'CREATOR',
    encryptedCredentialReference: 'enc-1',
    scopes: ['instagram_basic', 'instagram_content_publish'],
    capabilities: {
      accountRead: true, mediaRead: true, imagePublish: true, carouselPublish: true,
      reelPublish: true, storyPublish: true, mediaUpdate: true, mediaDeleteOrArchive: true,
      insightsRead: true, commentsRead: true, commentsReply: true
    },
    apiVersion: 'v20.0',
    policyProfileVersion: '2026-08-23.1',
    state: 'CONNECTED',
  };

  const decision = evaluateInstagramEligibility({
    connection: baseConnection,
    placement: 'IMAGE',
    media: [{ derivativeId: 'd-1', contentType: 'image/jpeg', byteSize: 500000, width: 1080, height: 1080 }],
    caption: 'My work on Instagram',
    contentRating: 'general',
    rightsAttested: true,
    creatorAttested: true,
  });

  assert.equal(decision.result, 'ALLOWED_MANAGED');
  assert.equal(decision.reasonCode, 'PREFLIGHT_ALLOWED');

  // Adult content excluded
  const adultDecision = evaluateInstagramEligibility({
    connection: baseConnection,
    placement: 'IMAGE',
    media: [{ derivativeId: 'd-1', contentType: 'image/jpeg', byteSize: 500000, width: 1080, height: 1080 }],
    caption: 'Adult post',
    contentRating: 'mature',
    rightsAttested: true,
    creatorAttested: true,
  });
  assert.equal(adultDecision.result, 'DESTINATION_POLICY_DENIED');
  assert.equal(adultDecision.reasonCode, 'PUBLIC_SAFE_PROFILE_DENIED');
});

test('evaluateFanvueRightsEligibility requires likeness clearance, adult attestation, and consent', () => {
  const result = evaluateFanvueRightsEligibility({
    ownershipAttested: true,
    everyParticipantAdultAttested: true,
    consentAttested: true,
    aiGenerated: false,
    aiDisclosureConfirmed: true,
    realPersonLikenessCleared: true,
    activeSafetyHold: false,
    platformPolicy: 'ELIGIBLE',
    connectionMode: 'CREATOR_OWNED',
    mediaSupported: true,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reasons.length, 0);

  const blocked = evaluateFanvueRightsEligibility({
    ownershipAttested: true,
    everyParticipantAdultAttested: false,
    consentAttested: true,
    aiGenerated: true,
    aiDisclosureConfirmed: false,
    realPersonLikenessCleared: false,
    activeSafetyHold: true,
    platformPolicy: 'ELIGIBLE',
    connectionMode: 'CREATOR_OWNED',
    mediaSupported: true,
  });
  assert.equal(blocked.eligible, false);
  assert.ok(blocked.reasons.includes('ACTIVE_SAFETY_HOLD'));
  assert.ok(blocked.reasons.includes('ADULT_ATTESTATION_REQUIRED'));
  assert.ok(blocked.reasons.includes('AI_DISCLOSURE_REQUIRED'));
  assert.ok(blocked.reasons.includes('LIKENESS_CLEARANCE_REQUIRED'));
});

test('PatreonAccessPolicy validates user tier access', () => {
  const mapping = {
    id: 'map-1',
    ownerId: 'creator-1',
    campaignId: 'camp-1',
    selectorIds: ['tier-vip', 'tier-patron'],
    accessGroupId: 'grp-1',
    active: true,
    graceSeconds: 86400,
    version: 1,
    safetyHold: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  assert.equal(PatreonAccessPolicy.evaluateAccess(mapping, ['tier-vip']), true);
  assert.equal(PatreonAccessPolicy.evaluateAccess(mapping, ['tier-free']), false);

  mapping.safetyHold = true;
  assert.equal(PatreonAccessPolicy.evaluateAccess(mapping, ['tier-vip']), false);
});

test('prioritizeExternalSyncJobs places interactive before background jobs', () => {
  const jobs = [
    {
      id: 'job-bg',
      type: 'collection_import',
      status: 'queued',
      createdAt: '2026-11-01T10:00:00Z',
      payload: { requestPriority: 'background' },
    },
    {
      id: 'job-interactive',
      type: 'publish',
      status: 'queued',
      createdAt: '2026-11-01T10:05:00Z',
      payload: { requestPriority: 'interactive' },
    },
  ];

  const sorted = prioritizeExternalSyncJobs(jobs);
  assert.equal(sorted[0].id, 'job-interactive');
  assert.equal(sorted[1].id, 'job-bg');
});

test('PersistentMessagingWorker requires absolute persistent-volume directory and lifecycle works cleanly', async (t) => {
  assert.throws(
    () => new PersistentMessagingWorker({
      dataDirectory: 'relative/path',
      instanceId: 'inst-1',
      ports: {
        async resolveLink() { return null; },
        async authorize() { return false; },
        async readActivity() { return { asOf: new Date().toISOString(), comments: [], favoriteCount: 0 }; },
      },
      whatsapp: {},
    }),
    /UBEEQ_MESSAGING_DATA_DIRECTORY must be an absolute/
  );

  const dir = mkdtempSync(join(tmpdir(), 'ubeeq-msg-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worker = new PersistentMessagingWorker({
    dataDirectory: dir,
    instanceId: 'inst-test',
    ports: {
      async resolveLink() { return null; },
      async authorize() { return false; },
      async readActivity() { return { asOf: new Date().toISOString(), comments: [], favoriteCount: 0 }; },
    },
    whatsapp: {
      phoneNumberId: '123456789',
      accessToken: 'test-token',
    },
  });

  worker.start();
  await worker.stop();
});
