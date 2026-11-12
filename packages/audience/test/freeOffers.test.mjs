import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FreeOfferService,
  MailingListService,
  InMemoryMailingRepository,
  MailingListError,
} from '../dist/index.js';

test('free offers lead magnet delivery and 7-day download verification', async () => {
  const repo = new InMemoryMailingRepository();
  const sentEmails = [];
  let currentTime = 1700000000000;
  const now = () => currentTime;

  const mailingService = new MailingListService(
    repo,
    async (email, subject, message) => {
      sentEmails.push({ email, subject, message });
    },
    'https://creator.example.test',
    now
  );
  const offerService = new FreeOfferService(repo, now);

  const creatorId = 'creator-lead-magnet';
  const profile = await mailingService.profile(creatorId);
  profile.enabled = true;
  profile.offers = [
    {
      id: 'offer-preset-pack',
      title: 'Analog Film Presets',
      description: 'Custom Lightroom presets',
      assetIds: ['preset-1'],
      assetWorkIds: { 'preset-1': 'work-preset' },
      enabled: true,
    },
  ];
  await repo.save(creatorId, 'profile', profile, 0);

  // List offers
  const offers = await offerService.listOffers(creatorId);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].id, 'offer-preset-pack');

  // Subscribe and confirm to receive grant
  await mailingService.subscribe(
    creatorId,
    { email: 'buyer@example.test', offerId: 'offer-preset-pack', consent: true },
    '127.0.0.1'
  );

  const token = sentEmails[0].message.match(/#([a-zA-Z0-9_-]+)/)[1];
  const subscriberId = sentEmails[0].message.match(/\/confirm\/([a-f0-9]{64})/)[1];
  const confirmResult = await mailingService.confirm(creatorId, subscriberId, token);
  assert.ok(confirmResult.grantId);
  assert.ok(confirmResult.token);

  // Verify grant download immediately
  const verified = await offerService.verifyGrantDownload(creatorId, confirmResult.grantId, confirmResult.token);
  assert.equal(verified.grant.id, confirmResult.grantId);
  assert.equal(verified.offer.id, 'offer-preset-pack');

  // Advance time past 7 days (7 * 86400000 + 1)
  currentTime += 7 * 86400000 + 1000;

  // Verification fails on expired grant
  await assert.rejects(
    async () => offerService.verifyGrantDownload(creatorId, confirmResult.grantId, confirmResult.token),
    (err) => err instanceof MailingListError && err.status === 401
  );
});
