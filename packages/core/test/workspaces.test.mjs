import test from 'node:test'; import assert from 'node:assert/strict';
import { createPersonalWorkspace, membershipAllows, professionalPublicationHash, approvalMatches, publicationExecutionBlocks, requireGrantHandover } from '../dist/workspaces.js';
const p={publicationId:'p',revision:1,workspaceId:'w',creatorIdentityId:'c',target:{provider:'linkedin',kind:'linkedin_organization',remoteId:'o',displayName:'Org'},caption:'Hi',items:[{workId:'a',renditionAssetId:'preview',position:0}]};
const m={workspaceId:'w',userId:'u',role:'publisher',status:'active'}; const g={id:'g',workspaceId:'w',connectionId:'c',provider:'linkedin',targetKind:'linkedin_organization',applicationDeploymentId:'d',authorizingUserId:'admin',externalPrincipalId:'x',targetIds:['o'],scopes:['w_organization_social'],credentialReference:'vault:x',status:'active'};
test('personal workspace and roles stay simple',()=>{const x=createPersonalWorkspace('u','Mine','w'); assert.equal(x.workspace.kind,'personal'); assert.equal(membershipAllows(x.membership,'publish'),true); assert.equal(membershipAllows({...m,role:'editor'},'publish'),false)});
test('approval binds the complete revision',async()=>{const a={publicationId:'p',revision:1,payloadHash:await professionalPublicationHash(p),approverUserId:'x',approvedAt:'2026-10-01T00:00:00Z'}; assert.equal(await approvalMatches(p,a),true); assert.equal(await approvalMatches({...p,caption:'changed'},a),false)});
test('dispatch rechecks local and remote authority',async()=>{assert.deepEqual(await publicationExecutionBlocks({membership:m,publication:p,grant:g}),[]); assert.deepEqual(await publicationExecutionBlocks({membership:{...m,status:'removed'},publication:p,grant:{...g,targetIds:['z']},approvalRequired:true}),['membership','target','approval'])});
test('offboarding pauses grants',()=>assert.equal(requireGrantHandover(g,'admin').status,'handover_required'));

test('canonical approvals survive JSON property reordering and bind every executable field', async () => {
  const hash = await professionalPublicationHash(p);
  assert.equal(hash, await professionalPublicationHash(Object.fromEntries(Object.entries(p).reverse())));
  assert.equal(hash, await professionalPublicationHash({ ...p, target: { ...p.target, displayName: 'Renamed' } }));
  for (const changed of [{ caption: 'Other' }, { target: { ...p.target, remoteId: 'other' } }, { items: [{ ...p.items[0], altText: 'Other' }] }])
    assert.notEqual(hash, await professionalPublicationHash({ ...p, ...changed }));
  await assert.rejects(() => professionalPublicationHash({ ...p, items: [...p.items, p.items[0]] }), /positions/);
});
test('runtime membership, expiry, scopes, deployment and target kind fail closed', async () => {
  assert.equal(membershipAllows({ ...m, role: 'unknown' }, 'publish'), false);
  for (const change of [{ expiresAt: 'not-a-date' }, { scopes: [] }, { targetKind: 'linkedin_member' }])
    assert.notDeepEqual(await publicationExecutionBlocks({ membership: m, publication: p, grant: { ...g, ...change } }), []);
  assert.ok((await publicationExecutionBlocks({ membership: m, publication: p, grant: g, applicationDeploymentId: 'another' })).includes('grant'));
  assert.deepEqual(await publicationExecutionBlocks({ membership: m, publication: { ...p, items: [] }, grant: g }), []);
  assert.ok((await publicationExecutionBlocks({ membership: { ...m, resourceIds: ['a'] }, publication: { ...p, items: [] }, grant: g })).includes('membership'));
});

test('authorization observes membership and payload changes during asynchronous hashing', async () => {
  const publication = structuredClone(p), membership = structuredClone(m);
  const approval = { publicationId: p.publicationId, revision: p.revision, payloadHash: await professionalPublicationHash(p), approverUserId: 'owner', approvedAt: '2026-10-01T00:00:00Z' };
  const pending = publicationExecutionBlocks({ publication, membership, grant: g, approval, approvalRequired: true });
  membership.status = 'suspended'; publication.caption = 'changed during hash';
  const blocks = await pending; assert.ok(blocks.includes('membership')); assert.ok(blocks.includes('publication_changed')); assert.ok(blocks.includes('approval'));
});
