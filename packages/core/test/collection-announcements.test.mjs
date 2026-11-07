import test from 'node:test';
import assert from 'node:assert/strict';
import {
  announcementDestinationKey, announcementPlanKey, announcementDestinationStepKey,
  evaluateCollectionReleaseReadiness, reserveCollectionRelease, recordCollectionReleaseExposure,
  finishCollectionReleaseReservation, defaultCollectionAnnouncementPreferences,
  resolveCollectionAnnouncementPreferences, renderAnnouncementTemplate, validateAnnouncementTemplate,
  createAnnouncementPlan, evaluateAnnouncementPlan, reserveAnnouncementMaterialization,
  completeAnnouncementMaterialization, announcementLogicalRow, assertAnnouncementSendEligible,
  replaceUnsentAnnouncementSteps, aggregateAnnouncementSteps, isDurableAnnouncementUrl,
} from '../dist/index.js';

const now = '2026-11-05T12:00:00.000Z';
const target = { provider: 'custom', accountId: 'account', connectionId: 'connection', targetId: 'collection', postType: 'gallery' };
const key = announcementDestinationKey(target);
const scope = { tenantId: 'tenant', creatorId: 'creator', collectionId: 'collection' };
const requirement = (id = 'one', overrides = {}) => ({ resultId: id, publicationId: `publication-${id}`, workId: id, target,
  contentRevision: '1', collectionRevision: '3', placementId: 'gallery', audience: 'public', required: true, kind: 'external_gallery', ...overrides });
const observation = (r, overrides = {}) => ({ releaseId: 'release', ...r, observedAt: now, state: 'confirmed',
  evidence: { reference: `evidence-${r.resultId}`, kind: r.kind, publishedAt: now, publicationLive: true, placementConfirmed: true, audienceAvailable: true, durableUrl: 'https://example.test/collection' }, ...overrides });
const ready = (requirements, observations, overrides = {}) => evaluateCollectionReleaseReadiness({ releaseId: 'release', requirements, observations, rule: { mode: 'all_required' }, now, ...overrides });
const baseline = () => ({ ...scope, schemaVersion: 1, revision: 1, initialized: true, releasedWorkIds: [], evidence: [], reservations: [] });

test('primary exposure consumes initial identity while late optional results retain their reservation and evidence', () => {
  const a = requirement('one'), optional = requirement('optional', { workId: 'one', target: { ...target, targetId: 'optional-gallery' } });
  let b = reserveCollectionRelease({ baseline: baseline(), expectedRevision: 1, releaseId: 'release', requestedWorkIds: ['one'] }).baseline;
  b = recordCollectionReleaseExposure({ baseline: b, expectedRevision: b.revision, releaseId: 'release', requirements: [a, optional], observations: [observation(a)], now });
  assert.equal(b.initialReleaseId, 'release');
  assert.equal(b.initialClaimReleaseId, undefined);
  assert.equal(b.reservations.length, 1);
  const next = reserveCollectionRelease({ baseline: b, expectedRevision: b.revision, releaseId: 'later', requestedWorkIds: ['two'] });
  assert.equal(next.reservation.kind, 'additions');
  b = recordCollectionReleaseExposure({ baseline: next.baseline, expectedRevision: next.baseline.revision, releaseId: 'release', requirements: [a, optional], observations: [observation(a), observation(optional)], now });
  assert.equal(b.evidence.length, 2);
  b = finishCollectionReleaseReservation(b, b.revision, 'release');
  const copy = requirement('another-copy', { workId: 'one', target: { ...target, targetId: 'another-gallery' } });
  assert.equal(reserveCollectionRelease({ baseline: b, expectedRevision: b.revision, releaseId: 'copy', requestedWorkIds: ['one'] }).state, 'noop');
  b = recordCollectionReleaseExposure({ baseline: b, expectedRevision: b.revision, releaseId: 'copy', requirements: [copy], observations: [observation(copy, { releaseId: 'copy' })], now });
  assert.equal(b.evidence.length, 3);
  assert.deepEqual(b.releasedWorkIds, ['one']);
});

test('exact content publication and placement evidence is required; submission and job success are insufficient', () => {
  const r = requirement();
  assert.equal(ready([r], []).ready, false);
  for (const state of ['pending', 'failed', 'unknown', 'unsupported']) assert.equal(ready([r], [observation(r, { state })]).ready, false);
  for (const field of ['publicationId', 'workId', 'contentRevision', 'collectionRevision', 'placementId', 'audience']) {
    const value = ready([r], [observation(r, { [field]: 'different' })]);
    assert.equal(value.ready, false, field);
    assert.equal(value.holds[0].code, 'SOURCE_CHANGED');
  }
  for (const field of ['accountId', 'connectionId', 'targetId', 'postType']) assert.equal(ready([r], [observation(r, { target: { ...target, [field]: 'different' } })]).ready, false);
  for (const field of ['publicationLive', 'placementConfirmed', 'audienceAvailable']) {
    const o = observation(r); o.evidence[field] = false;
    assert.equal(ready([r], [o]).ready, false, field);
  }
  assert.equal(ready([r], [observation(r)]).ready, true);
});
test('website active revision, native scheduled availability and forum message evidence are verified independently', () => {
  const r = requirement('one', { kind: 'website', deploymentRevision: 'build-4' });
  const o = observation(r);
  assert.equal(ready([r], [o]).ready, false);
  o.evidence.activeDeploymentRevision = 'build-3';
  assert.equal(ready([r], [o]).ready, false);
  o.evidence.activeDeploymentRevision = 'build-4';
  assert.equal(ready([r], [o]).ready, true);
  const native = requirement('one', { kind: 'native' }), n = observation(native);
  n.evidence.availableAt = '2026-11-06T12:00:00.000Z';
  assert.equal(ready([native], [n]).ready, false);
  assert.equal(ready([native], [n], { now: n.evidence.availableAt }).ready, true);
  const forum = requirement('one', { kind: 'collection_forum' }), f = observation(forum);
  assert.equal(ready([forum], [f]).ready, false);
  f.evidence.requiredMessagesConfirmed = true; f.evidence.remoteIds = ['thread', 'content-message'];
  assert.equal(ready([forum], [f]).ready, true);
  const future = requirement('one', { kind: 'adapter' }), a = observation(future);
  assert.equal(ready([future], [a]).ready, false);
  a.evidence.revisionCompletionSupported = true;
  assert.equal(ready([future], [a]).ready, true);
});
test('optional destinations only block primary completion when selected as announcement links', () => {
  const a = requirement('one'), b = requirement('two', { target: { ...target, targetId: 'other' }, required: false });
  const rule = { mode: 'primary_destination', destinationKey: key };
  assert.equal(ready([a, b], [observation(a)], { rule }).ready, true);
  const links = [{ label: 'Secondary gallery', destinationKey: announcementDestinationKey(b.target), resultIds: [b.resultId] }];
  const held = ready([a, b], [observation(a)], { rule, links });
  assert.equal(held.ready, false);
  assert.equal(held.holds[0].code, 'LINK_NOT_READY');
  assert.match(held.holds[0].message, /Secondary gallery/);
  assert.equal(ready([a, b], [observation(a), observation(b)], { rule, links }).ready, true);
});
test('work counts are distinct from result counts and unrelated observations cannot expand the snapshot', () => {
  const a = requirement('one'), b = requirement('copy', { workId: 'one', target: { ...target, targetId: 'copy' } });
  const value = ready([a, b], [observation(a), observation(requirement('unrelated'))]);
  assert.equal(value.requiredResultCount, 2); assert.equal(value.confirmedRequiredResultCount, 1);
  assert.equal(value.expectedWorkCount, 1); assert.equal(value.confirmedWorkCount, 0);
  assert.equal(ready([a, b], [observation(a), observation(b)]).confirmedWorkCount, 1);
  assert.equal(ready([], []).ready, false);
  assert.equal(ready([a], [observation(a), observation(a)]).ready, false);
  assert.equal(ready([a], [observation(a, { releaseId: 'other-release' })]).ready, false);
  assert.throws(() => ready([a, a], []), /unique/);
});
test('future, invalid and stale-copy evidence cannot make a release ready', () => {
  const r = requirement();
  for (const date of ['tomorrow', '2026-11-06T00:00:00Z', '2026-11-05T12:00:00']) {
    assert.equal(ready([r], [observation(r, { observedAt: date })]).ready, false);
    const o = observation(r); o.evidence.publishedAt = date;
    assert.equal(ready([r], [o]).ready, false);
  }
});
test('initial and overlapping additions reserve once and unexposed cancellation frees classification', () => {
  const first = reserveCollectionRelease({ baseline: baseline(), expectedRevision: 1, releaseId: 'release', requestedWorkIds: ['one', 'two'] });
  assert.equal(first.reservation.kind, 'initial');
  assert.equal(first.baseline.revision, 2);
  const repeated = reserveCollectionRelease({ baseline: first.baseline, expectedRevision: 2, releaseId: 'release', requestedWorkIds: ['one', 'two', 'later-local-draft'] });
  assert.deepEqual(repeated.reservation.workIds, ['one', 'two']);
  const blocked = reserveCollectionRelease({ baseline: first.baseline, expectedRevision: 2, releaseId: 'second', requestedWorkIds: ['three'] });
  assert.equal(blocked.state, 'waiting');
  const freed = finishCollectionReleaseReservation(first.baseline, 2, 'release');
  const second = reserveCollectionRelease({ baseline: freed, expectedRevision: 3, releaseId: 'second', requestedWorkIds: ['three'] });
  assert.equal(second.reservation.kind, 'initial');
  assert.throws(() => reserveCollectionRelease({ baseline: freed, expectedRevision: 2, releaseId: 'stale', requestedWorkIds: ['one'] }), { code: 'GENERATION_CONFLICT' });
});
test('confirmed exposure advances baseline despite an unsent or failed announcement; re-add and new copies are noops', () => {
  let b = reserveCollectionRelease({ baseline: baseline(), expectedRevision: 1, releaseId: 'release', requestedWorkIds: ['one', 'two'] }).baseline;
  const a = requirement('one'), pending = requirement('two');
  b = recordCollectionReleaseExposure({ baseline: b, expectedRevision: 2, releaseId: 'release', requirements: [a, pending], observations: [observation(a)], now });
  assert.deepEqual(b.releasedWorkIds, ['one']);
  assert.equal(b.initialReleaseId, 'release');
  const repeated = recordCollectionReleaseExposure({ baseline: b, expectedRevision: 3, releaseId: 'release', requirements: [a, pending], observations: [observation(a)], now });
  assert.equal(repeated.revision, 3);
  b = finishCollectionReleaseReservation(b, 3, 'release');
  assert.equal(reserveCollectionRelease({ baseline: b, expectedRevision: 4, releaseId: 'copy', requestedWorkIds: ['one'] }).state, 'noop');
  const additions = reserveCollectionRelease({ baseline: b, expectedRevision: 4, releaseId: 'additions', requestedWorkIds: ['one', 'two', 'three'] });
  assert.equal(additions.reservation.kind, 'additions');
  assert.deepEqual(additions.reservation.workIds, ['two', 'three']);
  const overlap = reserveCollectionRelease({ baseline: additions.baseline, expectedRevision: 5, releaseId: 'overlap', requestedWorkIds: ['two', 'four'] });
  assert.equal(overlap.state, 'waiting');
  assert.equal(reserveCollectionRelease({ baseline: baseline(), expectedRevision: 1, releaseId: 'empty', requestedWorkIds: [] }).state, 'noop');
  assert.throws(() => reserveCollectionRelease({ baseline: { ...baseline(), initialized: false }, expectedRevision: 1, releaseId: 'old-content', requestedWorkIds: ['one'] }), { code: 'REVIEW_REQUIRED' });
});
test('preference resolution preserves inheritance and detached versioned snapshots', () => {
  const defaults = defaultCollectionAnnouncementPreferences('America/Winnipeg');
  assert.equal(defaults.initial.behaviour, 'off'); assert.equal(defaults.additions.behaviour, 'off');
  const collection = { revision: 3, patch: { initial: { media: { mode: 'cover', altText: 'Cover' }, timing: null } } };
  const resolved = resolveCollectionAnnouncementPreferences({ creator: { revision: 2, settings: defaults }, collection,
    release: { revision: 1, patch: { initial: { media: { mode: 'none' } } } } });
  assert.deepEqual(resolved.contributingRevisions, { creator: 2, collection: 3, release: 1 });
  assert.equal(resolved.inheritance.initial.media, 'release'); assert.equal(resolved.inheritance.initial.timing, 'creator');
  defaults.initial.timing.timeZone = 'Asia/Kathmandu';
  assert.equal(resolved.settings.initial.timing.timeZone, 'America/Winnipeg');
  assert.equal(resolveCollectionAnnouncementPreferences({ creator: { revision: 3, settings: defaults }, collection }).settings.initial.timing.timeZone, 'Asia/Kathmandu');
  assert.throws(() => resolveCollectionAnnouncementPreferences({ creator: { revision: 1, settings: defaults }, collection: { revision: 1, patch: { initial: { behaviour: 'automatic' } } } }), /destinations/);
});
test('templates substitute only fixed variables into typed fields, with unresolved values and unequal counts held', () => {
  const template = { blocks: [{ id: 'text', type: 'paragraph', text: '{{collection.title}}: {{release.newWorkCount}}', children: [{ id: 'link', type: 'link', url: '{{primaryLink.url}}' }] }] };
  const rendered = renderAnnouncementTemplate({ template, values: { 'collection.title': '<script>inert text</script>', 'release.newWorkCount': 2, 'primaryLink.url': 'https://example.test/collection' } });
  assert.equal(rendered[0].text, '<script>inert text</script>: 2');
  assert.equal(template.blocks[0].text, '{{collection.title}}: {{release.newWorkCount}}');
  assert.throws(() => renderAnnouncementTemplate({ template, values: { 'collection.title': 'Title' } }), /Resolve/);
  assert.throws(() => renderAnnouncementTemplate({ template, sharedCountsAvailable: false, values: { 'collection.title': 'Title', 'release.newWorkCount': 2 } }), { code: 'REVIEW_REQUIRED' });
  for (const text of ['{{process.env.SECRET}}', '{{release.newWorkCount + 1}}', '{{collection.title'])
    assert.throws(() => validateAnnouncementTemplate({ blocks: [{ id: 'bad', type: 'paragraph', text }] }));
  for (const field of ['html', 'data']) assert.throws(() => validateAnnouncementTemplate({ blocks: [{ id: 'bad', type: 'paragraph', [field]: '{{collection.title}}' }] }), /typed/);
});
test('credential-bearing primary links fail rather than being silently rewritten', () => {
  for (const url of ['https://example.test/?token=private', 'https://example.test/?X-Amz-Signature=secret', 'https://user:password@example.test/', 'javascript:alert(1)', 'https://cdn.discordapp.com/file?ex=123&hm=secret']) assert.equal(isDurableAnnouncementUrl(url), false, url);
  assert.equal(isDurableAnnouncementUrl('https://example.test/?page=2'), true);
});

const plan = (overrides = {}) => createAnnouncementPlan({ ...scope, planId: 'plan', origin: 'manual', actorId: 'actor', kind: 'ad_hoc', authorizationRevision: 1, behaviour: 'automatic', latePolicy: { mode: 'hold', maximumLatenessMs: 86400000 }, now, ...overrides });
const step = (id = 'one', overrides = {}) => ({ logicalStepId: id, destinationKey: key, generation: 1, contentRevision: 'content-1', dueAt: now, state: 'pending', deliveryId: `delivery-${id}`, ...overrides });
const active = (overrides = {}) => { let p = plan(overrides); p = reserveAnnouncementMaterialization(p, p.revision, now); return completeAnnouncementMaterialization(p, p.revision, p.materialization.announcementId, now); };
test('withdrawn confirmed content requires review for initial and follow-up plans, while an authored waiting draft can remain unresolved', () => {
  const r=requirement(), readiness=ready([r],[observation(r)]);
  for(const kind of ['initial','follow_up']){
    let p=plan({releaseId:'release',kind,...(kind==='follow_up'?{parentPlanId:'parent'}:{})});
    p=evaluateAnnouncementPlan({plan:p,expectedRevision:p.revision,featureEnabled:true,readiness,schedule:{state:'due',dueAt:now,holds:[]},now});
    assert.equal(p.releaseReadyAt,now);
    p=evaluateAnnouncementPlan({plan:p,expectedRevision:p.revision,featureEnabled:true,readiness:ready([r],[]),now});
    assert.equal(p.gateState,'held');assert.equal(p.holds[0].code,'SOURCE_CHANGED');
    p=evaluateAnnouncementPlan({plan:p,expectedRevision:p.revision,featureEnabled:true,readiness,schedule:{state:'due',dueAt:now,holds:[]},now});
    assert.equal(p.gateState,'held');
    p=evaluateAnnouncementPlan({plan:p,expectedRevision:p.revision,featureEnabled:true,readiness,schedule:{state:'due',dueAt:now,holds:[]},reviewedAuthorizationRevision:p.authorizationRevision+1,now});
    assert.equal(p.gateState,'ready_to_prepare');
  }
  const authored={...plan({releaseId:'release'}),materialization:{state:'materialized',announcementId:'manual-author'}};
  assert.equal(evaluateAnnouncementPlan({plan:authored,expectedRevision:authored.revision,featureEnabled:true,readiness:ready([r],[]),now}).gateState,'waiting_publication');
});
test('materialization resumes the same reserved ID and exposes only one logical row after durable creation', () => {
  let p = plan();
  assert.equal(announcementLogicalRow(p).announcementId, undefined);
  p = reserveAnnouncementMaterialization(p, 1, now);
  assert.equal(announcementLogicalRow(p).announcementId, undefined);
  const retry = reserveAnnouncementMaterialization(p, 2, now);
  assert.deepEqual(retry, p);
  p = completeAnnouncementMaterialization(p, 2, p.materialization.announcementId, now);
  assert.equal(announcementLogicalRow(p).logicalRowId, 'plan');
  assert.equal(announcementLogicalRow(p).announcementId, 'announcement:plan');
  assert.deepEqual(completeAnnouncementMaterialization(p, p.revision, 'announcement:plan', now), p);
  assert.throws(() => reserveAnnouncementMaterialization({ ...p, materialization: undefined, gateState: 'waiting_publication' }, p.revision, now), { code: 'PUBLICATION_PENDING' });
});
test('readiness gates draft materialization and permanently records the first readiness instant', () => {
  let p = plan({ releaseId: 'release', kind: 'initial', behaviour: 'draft' });
  p = evaluateAnnouncementPlan({ plan: p, expectedRevision: 1, featureEnabled: true, now });
  assert.equal(p.gateState, 'waiting_publication');
  const r = requirement(), readiness = ready([r], [observation(r)]);
  p = evaluateAnnouncementPlan({ plan: p, expectedRevision: p.revision, readiness, featureEnabled: true, now });
  assert.equal(p.gateState, 'ready_to_prepare'); assert.equal(p.releaseReadyAt, now);
  p = evaluateAnnouncementPlan({ plan: p, expectedRevision: p.revision, readiness, featureEnabled: true, now: '2026-11-05T13:00:00Z' });
  assert.equal(p.releaseReadyAt, now);
  assert.throws(() => createAnnouncementPlan({ ...plan(), origin: 'imported', now }), /origin/);
});
test('material changes require reviewed authorization; transient feature pause resumes after reevaluation', () => {
  let p = active();
  p = evaluateAnnouncementPlan({ plan: p, expectedRevision: p.revision, featureEnabled: true, validationHolds: [{ code: 'PERMISSION_CHANGED', message: 'Creator access changed.' }], now });
  p = evaluateAnnouncementPlan({ plan: p, expectedRevision: p.revision, featureEnabled: true, now });
  assert.equal(p.gateState, 'held');
  p = evaluateAnnouncementPlan({ plan: p, expectedRevision: p.revision, featureEnabled: true, reviewedAuthorizationRevision: 2, now });
  assert.equal(p.gateState, 'active'); assert.equal(p.authorizationRevision, 2);
  p = evaluateAnnouncementPlan({ plan: p, expectedRevision: p.revision, featureEnabled: false, now });
  assert.equal(p.gateState, 'held');
  p = evaluateAnnouncementPlan({ plan: p, expectedRevision: p.revision, featureEnabled: true, now });
  assert.equal(p.gateState, 'active');
});
test('a draft can be prepared with a past informational schedule but cannot acquire send authorization', () => {
  let p = plan({ behaviour: 'draft' });
  p = evaluateAnnouncementPlan({ plan: p, expectedRevision: p.revision, featureEnabled: true, now,
    schedule: { state: 'held', dueAt: '2026-11-01T12:00:00Z', holds: [{ code: 'SCHEDULE_EXPIRED', message: 'Review the time before sending.' }] } });
  assert.equal(p.gateState, 'ready_to_prepare');
  p = reserveAnnouncementMaterialization(p, p.revision, now);
  p = completeAnnouncementMaterialization(p, p.revision, p.materialization.announcementId, now);
  assert.equal(p.gateState, 'active'); assert.equal(p.behaviour, 'draft');
  assert.equal(p.holds[0].code, 'SCHEDULE_EXPIRED');
});
test('send claims fence drafts, early wakes, stale generations, unknown outcomes and changed access', () => {
  const p = active();
  const input = { plan: p, step: step(), expectedRevision: p.revision, expectedGeneration: 1, featureEnabled: true, authorizationValid: true, sourceAvailable: true, linksAvailable: true, policyAllowed: true, now };
  assert.doesNotThrow(() => assertAnnouncementSendEligible(input));
  for (const field of ['featureEnabled', 'authorizationValid', 'sourceAvailable', 'linksAvailable', 'policyAllowed']) assert.throws(() => assertAnnouncementSendEligible({ ...input, [field]: false }), field);
  assert.throws(() => assertAnnouncementSendEligible({ ...input, plan: { ...p, behaviour: 'draft' } }));
  assert.throws(() => assertAnnouncementSendEligible({ ...input, now: '2026-11-05T11:59:59Z' }), { code: 'PUBLICATION_PENDING' });
  assert.throws(() => assertAnnouncementSendEligible({ ...input, now: '2026-11-06T12:00:01Z' }), { code: 'SCHEDULE_EXPIRED' });
  for (const state of ['sending', 'published', 'provider_draft', 'cancelled', 'needs_reconciliation']) assert.throws(() => assertAnnouncementSendEligible({ ...input, step: step('one', { state }) }));
  assert.throws(() => assertAnnouncementSendEligible({ ...input, expectedGeneration: 2 }), { code: 'GENERATION_CONFLICT' });
});
test('replacement preserves sent content and identities, retains tombstones and conflicts with a send claim', () => {
  const p = active(), sent = step('sent', { state: 'published', contentRevision: 'original', sentAt: now }), pending = step();
  const replacements = [{ logicalStepId: 'one', dueAt: '2026-11-06T12:00:00Z', contentRevision: 'revised', deliveryId: 'replacement' }];
  const input = { plan: p, expectedRevision: p.revision, expectedGeneration: 1, steps: [sent, pending], replacements, now };
  const result = replaceUnsentAnnouncementSteps(input);
  assert.equal(result.plan.planId, p.planId); assert.deepEqual(result.plan.materialization, p.materialization);
  assert.equal(result.plan.generation, 2); assert.deepEqual(result.steps[0], sent);
  assert.equal(result.steps[1].supersedesDeliveryId, pending.deliveryId);
  assert.equal(result.steps[1].logicalStepId, pending.logicalStepId);
  assert.equal(result.superseded[0].state, 'cancelled');
  for (const state of ['sending', 'needs_reconciliation', 'published']) assert.throws(() => replaceUnsentAnnouncementSteps({ ...input, steps: [sent, { ...pending, state }] }));
  assert.equal(aggregateAnnouncementSteps(['one'], []), 'failed');
  assert.equal(aggregateAnnouncementSteps(['sent', 'one'], [sent, pending]), 'partially_sent');
  assert.equal(aggregateAnnouncementSteps(['one'], [step('one', { state: 'provider_draft' })]), 'sent');
});
test('logical identities include account, target and post type, and exclude replacement generations', () => {
  const id = announcementPlanKey(scope, 'release', 'initial');
  assert.notEqual(id, announcementPlanKey(scope, 'release', 'additions'));
  assert.notEqual(announcementDestinationStepKey(id, target), announcementDestinationStepKey(id, { ...target, postType: 'status' }));
});
test('typed list items and image descriptions interpolate without evaluating arbitrary document data',()=>{
 const template={blocks:[{id:'list',type:'paragraph',items:['{{collection.title}}','{{release.newWorkCount}} new works'],alt:'Cover for {{collection.title}}'}]};
 const result=renderAnnouncementTemplate({template,values:{'collection.title':'Stories','release.newWorkCount':2}});
 assert.deepEqual(result[0].items,['Stories','2 new works']);assert.equal(result[0].alt,'Cover for Stories');
 assert.throws(()=>validateAnnouncementTemplate({blocks:[{id:'bad',type:'paragraph',items:['{{unknown}}']}]}),/Unknown/);
});
test('product-constrained authoring identifiers are reserved deterministically and cannot change on recovery',()=>{
 const p=plan(),reserved=reserveAnnouncementMaterialization(p,p.revision,now,'bounded-authoring-id');
 assert.equal(reserved.materialization.announcementId,'bounded-authoring-id');
 assert.deepEqual(reserveAnnouncementMaterialization(reserved,reserved.revision,now,'bounded-authoring-id'),reserved);
 assert.throws(()=>reserveAnnouncementMaterialization(reserved,reserved.revision,now,'other-authoring-id'),{code:'GENERATION_CONFLICT'});
});

test('an unrepresented required link is held for review instead of crashing release reconciliation', () => {
  const r=requirement();
  const result=ready([r],[observation(r)],{links:[{label:'Native collection',destinationKey:'native',resultIds:[]}]});
  assert.equal(result.ready,false);
  assert.deepEqual(result.holds.map(h=>h.code),['LINK_NOT_READY']);
});
test('follow-up template overrides must name a selected follow-up destination', () => {
  const settings=defaultCollectionAnnouncementPreferences('Etc/UTC');
  settings.initial.followUp={enabled:false,template:{blocks:[],destinationOverrides:{misspelled:[]}},destinations:[],media:{mode:'none'},timing:{mode:'delay_after_parent',timeZone:'Etc/UTC',durationMs:1000,anchor:{mode:'corresponding_destination'}},latePolicy:{mode:'hold',maximumLatenessMs:86400000}};
  assert.throws(()=>resolveCollectionAnnouncementPreferences({creator:{revision:1,settings}}),/selected.*destination/);
});
