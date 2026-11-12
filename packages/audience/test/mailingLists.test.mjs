import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MailingListService,
  InMemoryMailingRepository,
  exportSubscribersToCsv,
  mailingConsent,
  MailingListError,
} from '../dist/index.js';

test('mailing lists double opt-in subscription, confirmation, and unsubscribe', async () => {
  const repo = new InMemoryMailingRepository();
  const sentEmails = [];
  let currentTime = 1700000000000;
  const now = () => currentTime;

  const service = new MailingListService(
    repo,
    async (email, subject, message) => {
      sentEmails.push({ email, subject, message });
    },
    'https://creator.example.test',
    now
  );

  const creatorId = 'creator-1';

  // Initially disabled
  await assert.rejects(
    async () => service.subscribe(creatorId, { email: 'fan@example.test', consent: true }, '192.168.1.1'),
    (err) => err instanceof MailingListError && err.status === 404
  );

  // Enable profile
  const profile = await service.profile(creatorId);
  profile.enabled = true;
  profile.title = 'Artisan Dispatch';
  profile.senderName = 'Artisan Creator';
  profile.offers = [
    {
      id: 'offer-starter',
      title: 'Free Texture Pack',
      description: 'High-res paper textures',
      assetIds: ['asset-1', 'asset-2'],
      assetWorkIds: { 'asset-1': 'work-1', 'asset-2': 'work-1' },
      enabled: true,
    },
  ];
  await repo.save(creatorId, 'profile', profile, 0);

  // Subscribe without consent fails
  await assert.rejects(
    async () => service.subscribe(creatorId, { email: 'fan@example.test', consent: false }, '192.168.1.1'),
    (err) => err instanceof MailingListError && err.status === 422
  );

  // Subscribe successfully
  const subRes = await service.subscribe(
    creatorId,
    { email: 'fan@example.test', offerId: 'offer-starter', consent: true },
    '192.168.1.1'
  );
  assert.ok(subRes.message.includes('Check your inbox'));
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].email, 'fan@example.test');
  assert.equal(sentEmails[0].subject, 'Confirm your mailing-list signup');

  // Extract token from email body
  const match = sentEmails[0].message.match(/#([a-zA-Z0-9_-]+)/);
  assert.ok(match, 'Email must contain URL hash token');
  const token = match[1];

  const subscriberId = sentEmails[0].message.match(/\/confirm\/([a-f0-9]{64})/)[1];
  assert.ok(subscriberId);

  // Confirm subscription
  const confRes = await service.confirm(creatorId, subscriberId, token);
  assert.equal(confRes.message, 'Your signup is confirmed.');
  assert.ok(confRes.unsubscribeUrl);
  assert.ok(confRes.grantId);
  assert.ok(confRes.offer);
  assert.equal(confRes.offer.id, 'offer-starter');

  // Verify subscriber is now active
  const subscriber = await repo.get(creatorId, 'subscriber', subscriberId);
  assert.equal(subscriber.status, 'active');
  assert.ok(subscriber.unsubscribeToken);

  // Unsubscribe
  const unsubRes = await service.unsubscribe(creatorId, subscriberId, subscriber.unsubscribeToken);
  assert.ok(unsubRes.message.includes('You have been unsubscribed'));
  const afterUnsub = await repo.get(creatorId, 'subscriber', subscriberId);
  assert.equal(afterUnsub.status, 'unsubscribed');
});

test('rate limiting blocks excessive signups per email and IP', async () => {
  const repo = new InMemoryMailingRepository();
  let currentTime = 1700000000000;
  const now = () => currentTime;
  const service = new MailingListService(repo, async () => {}, 'https://creator.example.test', now);

  const creatorId = 'creator-rate';
  const profile = await service.profile(creatorId);
  profile.enabled = true;
  await repo.save(creatorId, 'profile', profile, 0);

  // Rapid repeat requests for same email blocked within 60 seconds
  await service.subscribe(creatorId, { email: 'flood@example.test', consent: true }, '10.0.0.1');

  await assert.rejects(
    async () => service.subscribe(creatorId, { email: 'flood@example.test', consent: true }, '10.0.0.1'),
    (err) => err instanceof MailingListError && err.status === 429
  );
});

test('exportSubscribersToCsv formats RFC 4180 with UTF-8 BOM and neutralizes spreadsheet formula injection', () => {
  const subscribers = [
    {
      id: 'sub-1',
      revision: 1,
      email: 'normal@example.test',
      status: 'active',
      createdAt: '2026-11-01T00:00:00Z',
      confirmedAt: '2026-11-01T00:01:00Z',
      consentText: 'Standard consent text',
      requestTimes: [],
    },
    {
      id: 'sub-2',
      revision: 1,
      email: '=1+1@example.test',
      status: 'active',
      createdAt: '2026-11-01T00:00:00Z',
      confirmedAt: '2026-11-01T00:02:00Z',
      consentText: '@cmd|"/c calc"!A0',
      requestTimes: [],
    },
    {
      id: 'sub-3',
      revision: 1,
      email: 'pending@example.test',
      status: 'pending',
      createdAt: '2026-11-01T00:00:00Z',
      requestTimes: [],
    },
  ];

  const csv = exportSubscribersToCsv(subscribers);
  assert.ok(csv.startsWith('\uFEFF"Email","Status"'), 'CSV must start with UTF-8 BOM and headers');
  assert.ok(csv.includes('"\'=1+1@example.test"'), 'Values starting with = must be prefixed with single quote');
  assert.ok(csv.includes('"\'@cmd|""/c calc""!A0"'), 'Formula injection tokens must be neutralized and quotes escaped');
  assert.equal(csv.includes('pending@example.test'), false, 'Only active subscribers must be exported');
});
