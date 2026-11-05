import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAnnouncementCivilTime, evaluateAnnouncementSchedule, evaluateAnnouncementFollowUpSchedule, validateAnnouncementTiming } from '../dist/index.js';
const latePolicy = { mode: 'hold', maximumLatenessMs: 86400000 };
const now = '2026-11-05T12:00:00.000Z';
const timeZone = 'America/Winnipeg';
test('civil time resolution rejects DST gaps and demands an explicit repeated-hour occurrence', () => {
  assert.throws(() => resolveAnnouncementCivilTime({ timeZone, localDateTime: '2026-03-08T02:30:00' }), /does not exist/);
  assert.throws(() => resolveAnnouncementCivilTime({ timeZone, localDateTime: '2026-11-01T01:30:00' }), { code: 'REVIEW_REQUIRED' });
  const earlier = resolveAnnouncementCivilTime({ timeZone, localDateTime: '2026-11-01T01:30:00', occurrence: 'earlier' });
  const later = resolveAnnouncementCivilTime({ timeZone, localDateTime: '2026-11-01T01:30:00', occurrence: 'later' });
  assert.equal(earlier.instant, '2026-11-01T06:30:00.000Z'); assert.equal(earlier.offsetMinutes, -300);
  assert.equal(later.instant, '2026-11-01T07:30:00.000Z'); assert.equal(later.offsetMinutes, -360);
  assert.deepEqual(resolveAnnouncementCivilTime({ timeZone, localDateTime: later.localDateTime, offsetMinutes: -360 }), later);
  assert.throws(() => resolveAnnouncementCivilTime({ timeZone, localDateTime: later.localDateTime, offsetMinutes: 0 }));
  assert.throws(() => resolveAnnouncementCivilTime({ timeZone: 'invalid', localDateTime: later.localDateTime }));
  assert.throws(() => resolveAnnouncementCivilTime({ timeZone, localDateTime: '2026-02-30T12:00:00' }));
});
test('fractional-offset zones and half-hour DST transitions retain the selected instant', () => {
  assert.equal(resolveAnnouncementCivilTime({ timeZone: 'Asia/Kathmandu', localDateTime: '2026-11-05T12:00:00' }).instant, '2026-11-05T06:15:00.000Z');
  const a = resolveAnnouncementCivilTime({ timeZone: 'Australia/Lord_Howe', localDateTime: '2026-04-05T01:45:00', occurrence: 'earlier' });
  const b = resolveAnnouncementCivilTime({ timeZone: 'Australia/Lord_Howe', localDateTime: '2026-04-05T01:45:00', occurrence: 'later' });
  assert.equal(Date.parse(b.instant) - Date.parse(a.instant), 1800000);
  assert.throws(() => validateAnnouncementTiming({ mode: 'at_time', civilTime: { ...a, instant: b.instant } }), /saved instant/);
});
test('relative plans have no invented time before publication; delays are elapsed durations', () => {
  const input = { timing: { mode: 'delay_after_publication', timeZone, durationMs: 86400000 }, latePolicy, now };
  const waiting = evaluateAnnouncementSchedule(input);
  assert.equal(waiting.state, 'waiting_publication'); assert.equal(waiting.dueAt, undefined);
  const scheduled = evaluateAnnouncementSchedule({ ...input, releaseReadyAt: now });
  assert.equal(scheduled.state, 'scheduled'); assert.equal(scheduled.dueAt, '2026-11-06T12:00:00.000Z');
  assert.equal(evaluateAnnouncementSchedule({ ...input, releaseReadyAt: now, now: scheduled.dueAt }).state, 'due');
  assert.throws(() => evaluateAnnouncementSchedule({ ...input, timing: { ...input.timing, durationMs: -1 } }));
});
test('missed absolute times hold or send when ready only within the saved maximum lateness', () => {
  const civilTime = resolveAnnouncementCivilTime({ timeZone: 'Etc/UTC', localDateTime: '2026-11-05T10:00:00' });
  const input = { timing: { mode: 'at_time', civilTime }, releaseReadyAt: now, latePolicy, now };
  assert.equal(evaluateAnnouncementSchedule(input).state, 'held');
  assert.equal(evaluateAnnouncementSchedule({ ...input, latePolicy: { ...latePolicy, mode: 'send_when_ready' } }).state, 'due');
  assert.equal(evaluateAnnouncementSchedule({ ...input, releaseReadyAt: '2026-11-05T09:00:00Z', now: '2026-11-06T10:00:00.001Z' }).state, 'held');
  assert.equal(evaluateAnnouncementSchedule({ ...input, latePolicy: { mode: 'send_when_ready', maximumLatenessMs: null }, now: '2027-01-01T00:00:00Z' }).state, 'due');
  const waiting = evaluateAnnouncementSchedule({ ...input, releaseReadyAt: undefined });
  assert.equal(waiting.requestedAt, civilTime.instant); assert.equal(waiting.dueAt, undefined);
});
const follow = (overrides = {}) => ({ timing: { mode: 'delay_after_parent', durationMs: 3600000, timeZone, anchor: { mode: 'corresponding_destination' } }, latePolicy, destinationKey: 'one', parentDestinationKeys: ['one', 'two'], parentDeliveries: [], now, ...overrides });
test('per-destination follow-ups anchor only to actual published delivery, including delayed destinations', () => {
  for (const outcome of ['pending', 'failed', 'unknown', 'draft']) assert.equal(evaluateAnnouncementFollowUpSchedule(follow({ parentDeliveries: [{ destinationKey: 'one', outcome, sentAt: now }] })).state, 'waiting_parent');
  const parentDeliveries = [{ destinationKey: 'one', outcome: 'published', sentAt: '2026-11-05T10:00:00Z' }, { destinationKey: 'two', outcome: 'published', sentAt: '2026-11-05T11:30:00Z' }];
  assert.equal(evaluateAnnouncementFollowUpSchedule(follow({ parentDeliveries })).dueAt, '2026-11-05T11:00:00.000Z');
  const two = evaluateAnnouncementFollowUpSchedule(follow({ parentDeliveries, destinationKey: 'two' }));
  assert.equal(two.dueAt, '2026-11-05T12:30:00.000Z'); assert.equal(two.state, 'scheduled');
  assert.equal(evaluateAnnouncementFollowUpSchedule(follow({ parentDeliveries: [], fixedAnchorAt: parentDeliveries[0].sentAt })).dueAt, '2026-11-05T11:00:00.000Z');
});
test('new follow-up targets require explicit anchors and cancellation only propagates through the selected parent', () => {
  assert.throws(() => evaluateAnnouncementFollowUpSchedule(follow({ destinationKey: 'new' })), /explicit existing parent/);
  const timing = { mode: 'delay_after_parent', timeZone, durationMs: 0, anchor: { mode: 'first_successful_initial_delivery' } };
  const parentDeliveries = [{ destinationKey: 'one', outcome: 'cancelled' }, { destinationKey: 'two', outcome: 'published', sentAt: now }];
  assert.equal(evaluateAnnouncementFollowUpSchedule(follow({ destinationKey: 'new', timing, parentDeliveries })).state, 'due');
  assert.equal(evaluateAnnouncementFollowUpSchedule(follow({ parentDeliveries })).state, 'cancelled');
  assert.equal(evaluateAnnouncementFollowUpSchedule(follow({ timing: { ...timing, anchor: { mode: 'parent_destination', destinationKey: 'two' } }, parentDeliveries })).state, 'due');
});
