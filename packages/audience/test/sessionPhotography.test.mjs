import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionPhotographyService,
  InMemoryPhotographyRepository,
  PhotographyError,
} from '../dist/index.js';

test('session photography 6-digit PIN verification, 1-hour session, and client proofing gallery access', async () => {
  const repo = new InMemoryPhotographyRepository();
  const sentEmails = [];
  let currentTime = 1700000000000;
  const now = () => currentTime;

  const service = new SessionPhotographyService(
    repo,
    async (email, subject, message) => {
      sentEmails.push({ email, subject, message });
    },
    now
  );

  const creatorId = 'creator-photo';

  // Setup photography state
  const state = await service.state(creatorId);
  state.enabled = true;
  state.galleries = [
    {
      id: 'gallery-wedding-1',
      title: 'Summer Wedding Proofs',
      emails: ['client@example.test'],
      assetIds: ['asset-p1', 'asset-p2'],
      downloads: true,
      active: true,
    },
  ];
  state.slots = [
    {
      id: 'slot-1',
      packageId: 'pkg-portrait',
      startsAt: new Date(currentTime + 86400000).toISOString(),
      endsAt: new Date(currentTime + 90000000).toISOString(),
      location: 'Studio A',
    },
  ];
  await repo.save(creatorId, state, 0);

  // Request PIN code for gallery
  const reqRes = await service.requestCode(creatorId, 'client@example.test', 'gallery-wedding-1', '127.0.0.1');
  assert.ok(reqRes.challengeId);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].email, 'client@example.test');

  // Extract 6-digit PIN from email
  const codeMatch = sentEmails[0].message.match(/\b\d{6}\b/);
  assert.ok(codeMatch);
  const code = codeMatch[0];

  // Ineligible user receives generic message without email dispatch
  const ineligibleEmailsCount = sentEmails.length;
  const ineligRes = await service.requestCode(creatorId, 'stranger@example.test', 'gallery-wedding-1', '127.0.0.1');
  assert.ok(ineligRes.challengeId);
  assert.equal(sentEmails.length, ineligibleEmailsCount, 'Ineligible email must not receive an email code');

  // Wrong code verification fails
  await assert.rejects(
    async () => service.verifyCode(creatorId, reqRes.challengeId, '000000'),
    (err) => err instanceof PhotographyError && err.status === 401
  );

  // Correct code verification returns 1-hour session
  const verifyRes = await service.verifyCode(creatorId, reqRes.challengeId, code);
  assert.ok(verifyRes.token);
  assert.equal(Date.parse(verifyRes.expiresAt) - currentTime, 3600000);

  // Gallery view authorized with token
  const gallery = await service.gallery(creatorId, 'gallery-wedding-1', verifyRes.token);
  assert.equal(gallery.id, 'gallery-wedding-1');
  assert.equal(gallery.title, 'Summer Wedding Proofs');

  // Advance time past 60-second cooldown
  currentTime += 65000;

  // Requesting code for booking scope
  const bookCodeReq = await service.requestCode(creatorId, 'client@example.test', 'booking', '127.0.0.1');
  const bookCodeMatch = sentEmails[sentEmails.length - 1].message.match(/\b\d{6}\b/);
  const bookVerify = await service.verifyCode(creatorId, bookCodeReq.challengeId, bookCodeMatch[0]);

  // Book a slot
  const booking = await service.book(creatorId, bookVerify.token, {
    slotId: 'slot-1',
    name: 'Jane Client',
    notes: 'Looking forward to the session!',
  });
  assert.equal(booking.slotId, 'slot-1');
  assert.equal(booking.status, 'requested');

  // Double booking same slot is rejected
  await assert.rejects(
    async () =>
      service.book(creatorId, bookVerify.token, {
        slotId: 'slot-1',
        name: 'Jane Client',
      }),
    (err) => err instanceof PhotographyError && err.status === 409
  );
});
