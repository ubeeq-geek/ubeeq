import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CommerceService, CommerceError, amountToMinor, minorToAmount } from '../dist/index.js';
import { SqliteCommerceStore } from '../../../adapters/local/dist/index.js';

const actor = { subjectId: 'creator-owner', ownerId: 'creator' };
const scope = { deploymentId: 'deployment', ownerId: 'creator', environment: 'sandbox' };
const key = 'test-key-with-at-least-thirty-two-characters';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ubeeq-commerce-')), path = join(dir, 'commerce.sqlite');
  let at = new Date('2026-11-01T12:00:00Z');
  let store = new SqliteCommerceStore('deployment', path, key);
  const files = new Map(), messages = [], providerEvidence = new Map(), members = new Map(), adds = [], removes = [];
  let captureCalls = 0, providerFailure = false;
  const provider = {
    createOrder: async order => ({ orderId: 'ORDER-' + order.id, approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=' + order.id, merchantId: 'merchant' }),
    capture: async () => { captureCalls++; if (providerFailure) throw Object.assign(Error('PRIVATE provider'), { code: 'rate_limited', retryAfterSeconds: 45 }); },
    reconcile: async (_scope, _connection, reference) => providerEvidence.get(reference.captureId ?? reference.orderId ?? reference.eventId) ?? []
  };
  const discord = {
    authorizationUrl: state => 'https://discord.com/oauth2/authorize?state=' + state, installUrl: () => 'https://discord.com/oauth2/authorize?scope=bot',
    exchange: async code => ({ userId: code, accessToken: 'SECRET' }), validateGuild: async () => {}, validateRoles: async () => {},
    member: async (guild, user) => members.has(guild + ':' + user) ? { roles: [...members.get(guild + ':' + user)] } : undefined,
    addRole: async (guild, user, role) => { adds.push(role); members.get(guild + ':' + user).add(role); },
    removeRole: async (guild, user, role) => { removes.push(role); members.get(guild + ':' + user).delete(role); }
  };
  const ports = { store, tokenKey: key, publicBaseUrl: 'https://shop.example.test', now: () => at,
    authorizeCreator: async a => { if (a.ownerId !== actor.ownerId || a.subjectId !== actor.subjectId) throw new CommerceError('forbidden', 403); },
    assertEligible: async s => { if (s.ownerId !== 'creator') throw new CommerceError('ineligible',403); },
    connection: async () => ({ id: 'connection', merchantId: 'merchant' }), withConnectionLock: (s, fn) => store.withLock(s, fn),
    markVerified: async () => {}, provider, mail: { send: async message => { messages.push(message); } }, discord,
    assets: { read: async asset => { if (!files.has(asset.objectId)) throw new CommerceError('content_unavailable',409); return files.get(asset.objectId); },
      limitBytes: async () => 1000000, putPackage: async (_scope,id,items) => { const bytes=Buffer.concat(items.map(i=>i.bytes)); files.set(id,bytes); return { objectId:id,byteLength:bytes.length,checksum:digest(bytes) }; } }
  };
  let service = new CommerceService(ports);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const drain = async () => { for (let i=0;i<100;i++) if (!await service.runNextJob('worker')) return; throw Error('job loop'); };
  const verify = async (subject='buyer', address='buyer@example.test') => { await service.beginEmailVerification(subject,address); await drain(); const message=messages.filter(m=>m.to===address&&m.subject.includes('Verify')).at(-1); const url=new URL(message.text); await service.verifyEmail(subject,url.searchParams.get('id'),url.searchParams.get('token')); return service.customerProfile(subject); };
  const asset = async (name='image.png', data=Buffer.from('private-content')) => { const id=name+'-'+files.size; files.set(id,data); return service.registerAsset(actor,'sandbox',{ label:name, contentType:'image/png', objectId:id, checksum:digest(data), byteLength:data.length, publicPreview:false, state:'available' }); };
  const offer = async (file, extra={}) => service.publishOffer(actor,{ environment:'sandbox',slug:'gallery',title:'Gallery',amountMinor:1000,currency:'USD',files:[file.id],benefits:[{type:'gallery',resourceId:'gallery'},{type:'download',resourceId:file.id}],terms:'One-time purchase. Support for refunds.',supportEmail:'creator@example.test',...extra });
  const checkout = async (o, subject='buyer', idem='purchase-12345') => { const order=await service.checkout(subject,o.id,idem); await drain(); return (await service.order(subject,order.id)).order; };
  const evidence = (order, extra={}) => ({ captureId:'CAPTURE-1',orderId:order.providerOrderId,reference:order.reference,merchantId:'merchant',currency:'USD',paidMinor:1000,refundedMinor:0,status:'completed',updatedAt:at.toISOString(),buyerEmail:'payer@example.test',...extra });
  return { get service(){return service;}, get store(){return store;}, ports, path, files, messages, provider, providerEvidence, members, adds, removes, drain, verify, asset, offer, checkout,evidence,
    get captureCalls(){return captureCalls;}, set providerFailure(value){providerFailure=value;}, advance: ms=>{at=new Date(at.getTime()+ms);},
    restart:()=>{store.close();store=new SqliteCommerceStore('deployment',path,key);ports.store=store;service=new CommerceService(ports);} };
}

test('money conversion is exact and rejects floating amounts, overflows and unsupported currency precision', () => {
  assert.equal(amountToMinor('123.45','USD'),12345);assert.equal(minorToAmount(12345,'USD'),'123.45');assert.equal(amountToMinor('100.00','JPY'),100);
  for(const [amount,currency] of [['1.001','USD'],['1.1','JPY'],['1e2','USD'],['-1','USD'],['9007199254740992000','USD'],['1','BHD']])assert.throws(()=>amountToMinor(amount,currency));
});

test('email proof binds only the signed-in customer, is single-use, and checkout requires verified recovery',async t=>{
  const f=await fixture(t),a=await f.asset(),o=await f.offer(a);
  await assert.rejects(f.service.checkout('buyer',o.id,'checkout-123'),{code:'verified_recovery_email_required'});
  await f.service.beginEmailVerification('buyer','buyer@example.test');await f.drain();const url=new URL(f.messages[0].text),id=url.searchParams.get('id'),token=url.searchParams.get('token');
  await assert.rejects(f.service.verifyEmail('other',id,token),{code:'invalid_email_proof'});
  await f.service.verifyEmail('buyer',id,token);await assert.rejects(f.service.verifyEmail('buyer',id,token),{code:'invalid_email_proof'});
  const order=await f.checkout(o);assert.equal(order.state,'pending');assert.equal((await f.service.purchases('buyer')).length,0);
});

test('concurrent capture reconciliation, duplicates and process restart create one purchase and grant set',async t=>{
  const f=await fixture(t);await f.verify();const a=await f.asset(),o=await f.offer(a),order=await f.checkout(o);
  f.restart();const data=f.evidence(order);
  await Promise.all(Array.from({length:5},()=>f.service.reconcile(scope,'connection',[data])));
  const purchases=await f.service.purchases('buyer');assert.equal(purchases.length,1);assert.equal(purchases[0].entitlements.length,2);
  assert.equal((await f.store.transaction(tx=>tx.list('payment'))).length,1);
  assert.equal((await f.service.checkout('buyer',o.id,'purchase-12345')).id,order.id);
  await assert.rejects(f.service.order('other',order.id),{code:'checkout_not_found'});
});

test('pending, declined, wrong merchant, amount, currency, mapping and reference never grant access',async t=>{
  const f=await fixture(t);await f.verify();const a=await f.asset(),o=await f.offer(a),order=await f.checkout(o);
  const cases=[{status:'pending'},{status:'failed'},{merchantId:'wrong'},{paidMinor:999},{currency:'CAD'},{reference:'forged'},{orderId:'unknown'},{unsupported:true}];
  for(let i=0;i<cases.length;i++)await f.service.reconcile(scope,'connection',[f.evidence(order,{captureId:'CAPTURE-'+i,...cases[i]})]);
  assert.equal((await f.service.purchases('buyer')).length,0);await assert.rejects(f.service.authorizeDownload('buyer',a.id),{code:'access_denied'});
});

test('full refund before a delayed completion never restores access; another purchase and manual grant survive',async t=>{
  const f=await fixture(t),customer=await f.verify(),a=await f.asset(),o=await f.offer(a),first=await f.checkout(o);
  await f.service.reconcile(scope,'connection',[f.evidence(first)]);const signed=await f.service.authorizeDownload('buyer',a.id);
  await f.service.reconcile(scope,'connection',[f.evidence(first,{status:'refunded',refundedMinor:1000})]);
  await assert.rejects(f.service.download(a.id,new URL(signed.url).searchParams.get('token')),{code:'access_denied'});
  await f.service.reconcile(scope,'connection',[f.evidence(first)]);assert.equal((await f.service.purchases('buyer'))[0].state,'revoked');
  const second=await f.checkout(o,'buyer','second-purchase');await f.service.reconcile(scope,'connection',[f.evidence(second,{captureId:'CAPTURE-2'})]);
  await f.service.authorizeDownload('buyer',a.id);
  const manual=await f.service.manualGrant(actor,{customerId:customer.id,environment:'sandbox',benefit:{type:'download',resourceId:a.id},reason:'Customer support'});
  await f.service.reconcile(scope,'connection',[f.evidence(second,{captureId:'CAPTURE-2',status:'reversed'})]);
  await f.service.authorizeDownload('buyer',a.id);await f.service.revoke(actor,manual.id,'Support grant ended');await assert.rejects(f.service.authorizeDownload('buyer',a.id),{code:'access_denied'});
});

test('cumulative refund IDs deduplicate; partial refunds remain active and require review',async t=>{
  const f=await fixture(t);await f.verify();const a=await f.asset(),o=await f.offer(a),order=await f.checkout(o);
  await f.service.reconcile(scope,'connection',[f.evidence(order)]);
  const partial=f.evidence(order,{status:'partially_refunded',refunds:[{id:'REFUND-1',amountMinor:400,state:'COMPLETED'}]});
  await f.service.reconcile(scope,'connection',[partial]);await f.service.reconcile(scope,'connection',[partial]);
  let p=(await f.service.purchases('buyer'))[0];assert.equal(p.payment.refundedMinor,400);assert.equal(p.payment.reviewReason,'partial_refund_access_remains_active');await f.service.authorizeDownload('buyer',a.id);
  await f.service.reconcile(scope,'connection',[f.evidence(order,{status:'partially_refunded',refunds:[{id:'REFUND-2',amountMinor:600,state:'COMPLETED'}]})]);
  p=(await f.service.purchases('buyer'))[0];assert.equal(p.payment.state,'refunded');assert.equal(p.state,'revoked');
});

test('offer versions snapshot content and duration; public withdrawal does not revoke purchases',async t=>{
  const f=await fixture(t);await f.verify();const a=await f.asset(),b=await f.asset('new.png',Buffer.from('new')),o=await f.offer(a,{durationSeconds:60}),order=await f.checkout(o);
  await f.service.reconcile(scope,'connection',[f.evidence(order)]);
  await f.offer(a,{offerId:o.offerId,files:[a.id,b.id],benefits:[{type:'gallery',resourceId:'gallery'}]});
  await assert.rejects(f.service.authorizeDownload('buyer',b.id),{code:'access_denied'});
  await f.service.setOfferPublished(actor,o.id,false);await f.service.authorizeDownload('buyer',a.id);
  f.advance(61000);await assert.rejects(f.service.authorizeDownload('buyer',a.id),{code:'access_denied'});
});

test('signed downloads expire in five minutes and reject other customers, tampering and unavailable content',async t=>{
  const f=await fixture(t);await f.verify();const a=await f.asset(),o=await f.offer(a),order=await f.checkout(o);await f.service.reconcile(scope,'connection',[f.evidence(order)]);
  const link=await f.service.authorizeDownload('buyer',a.id),token=new URL(link.url).searchParams.get('token');assert.deepEqual((await f.service.download(a.id,token)).bytes,f.files.get(a.objectId));
  await assert.rejects(f.service.authorizeDownload('other',a.id),{code:'access_denied'});await assert.rejects(f.service.preview(a.id),{code:'preview_not_found'});
  await assert.rejects(f.service.download(a.id,token+'x'),{code:'invalid_download'});
  await f.service.setAssetAvailability(actor,a.id,false);await assert.rejects(f.service.download(a.id,token),{code:'content_unavailable'});
  await f.service.setAssetAvailability(actor,a.id,true);f.advance(300001);await assert.rejects(f.service.download(a.id,token),{code:'invalid_download'});
});

test('direct purchases need demonstrated mapping and verified-email claims; guessed, reused and expired claims fail',async t=>{
  const f=await fixture(t),a=await f.asset(),o=await f.offer(a,{external:{url:'https://www.paypal.com/ncp/payment/LINK',mappingId:'SKU-1'}});
  const evidence={captureId:'EXTERNAL',merchantId:'merchant',currency:'USD',paidMinor:1000,refundedMinor:0,status:'completed',updatedAt:'2026-11-01T12:00:00Z',buyerEmail:'purchase@example.test',mappingId:'SKU-1'};
  await f.store.acceptEvent({connection:{...scope,id:'connection'},eventId:'LINK-EVENT',eventType:'PAYMENT.CAPTURE.COMPLETED',rawBody:Buffer.from('{"id":"LINK-EVENT"}'),receivedAt:'2026-11-01T12:00:00Z'});
  const eventId=(await f.store.transaction(tx=>tx.list('event')))[0].id;
  const [review]=await f.service.reconcile(scope,'connection',[evidence],eventId);assert.equal(review.state,'needs_review');assert.equal((await f.store.transaction(tx=>tx.list('purchase'))).length,0);
  f.providerEvidence.set('EXTERNAL',[evidence]);await f.service.validateExternalMapping(actor,o.id,review.id);await f.drain();
  const mail=f.messages.find(m=>m.subject==='Claim your purchase'),url=new URL(mail.text),id=url.searchParams.get('id'),token=url.searchParams.get('token');
  await f.verify('wrong','other@example.test');await assert.rejects(f.service.redeemClaim('wrong',id,token),{code:'purchase_email_verification_required'});
  await f.verify('buyer','purchase@example.test');await assert.rejects(f.service.redeemClaim('buyer',id,'guessed'),{code:'invalid_claim'});
  await f.service.redeemClaim('buyer',id,token);await assert.rejects(f.service.redeemClaim('buyer',id,token),{code:'invalid_claim'});
  await f.service.authorizeDownload('buyer',a.id);
  const serialized=JSON.stringify(await f.store.transaction(tx=>tx.list('claim')));assert.equal(serialized.includes(token),false);
  const extra={...evidence,captureId:'EXTERNAL-2'};await f.service.reconcile(scope,'connection',[extra]);await f.drain();const latest=new URL(f.messages.filter(m=>m.subject==='Claim your purchase').at(-1).text);f.advance(86400001);
  await assert.rejects(f.service.redeemClaim('buyer',latest.searchParams.get('id'),latest.searchParams.get('token')),{code:'invalid_claim'});
});

test('approval queues capture without access; retries survive restarts and keep capture idempotency stable',async t=>{
  const f=await fixture(t);await f.verify();const a=await f.asset(),o=await f.offer(a),order=await f.checkout(o);
  await f.store.acceptEvent({connection:{...scope,id:'connection'},eventId:'APPROVED',eventType:'CHECKOUT.ORDER.APPROVED',rawBody:Buffer.from(JSON.stringify({id:'APPROVED',resource:{id:order.providerOrderId}})),receivedAt:'2026-11-01T12:00:00Z'});
  f.providerFailure=true;await f.drain();assert.equal((await f.service.purchases('buyer')).length,0);assert.equal(f.captureCalls,1);
  const captureJob=(await f.store.transaction(tx=>tx.list('job'))).find(j=>j.kind==='capture');assert.equal(captureJob.state,'failed');assert.equal(captureJob.lastError,'rate_limited');
  f.restart();f.advance(46000);f.providerFailure=false;f.providerEvidence.set(order.providerOrderId,[f.evidence(order)]);await f.drain();assert.equal((await f.service.purchases('buyer')).length,1);assert.equal(f.captureCalls,2);
});

test('durable inbox deduplicates atomically with jobs, encrypts raw data, and isolates deployments',async t=>{
  const f=await fixture(t),event={connection:{...scope,id:'connection'},eventId:'EVENT',eventType:'PAYMENT.CAPTURE.COMPLETED',rawBody:Buffer.from('{"private":"sensitive-payer-data"}'),receivedAt:'2026-11-01T12:00:00Z'};
  assert.equal(await f.store.acceptEvent(event),'accepted');assert.equal(await f.store.acceptEvent(event),'duplicate');
  assert.equal((await f.store.transaction(tx=>tx.list('job'))).length,1);f.restart();assert.equal(await f.store.acceptEvent(event),'duplicate');
  const other=new SqliteCommerceStore('other-deployment',f.path,key);assert.deepEqual(await other.transaction(tx=>tx.list('event')),[]);other.close();
  const {readFileSync}=await import('node:fs');assert.equal(readFileSync(f.path).includes(Buffer.from('sensitive-payer-data')),false);
});

test('package content is built once per immutable version and policy unavailability blocks archive access',async t=>{
  const f=await fixture(t);await f.verify();const a=await f.asset(),o=await f.offer(a,{benefits:[{type:'gallery',resourceId:'gallery'},{type:'package',resourceId:'package'}]}),order=await f.checkout(o);
  await f.service.reconcile(scope,'connection',[f.evidence(order)]);const purchase=(await f.service.purchases('buyer'))[0],pack=purchase.packages[0];assert.equal(pack.state,'ready');
  const link=await f.service.authorizeDownload('buyer',pack.assetId);await f.service.download(pack.assetId,new URL(link.url).searchParams.get('token'));
  await f.service.setAssetAvailability(actor,a.id,false);await assert.rejects(f.service.authorizeDownload('buyer',pack.assetId),{code:'content_unavailable'});
});

test('Discord uses bound OAuth identity, retries membership failures and preserves independently supported roles',async t=>{
  const f=await fixture(t);await f.verify();const auth=await f.service.beginDiscord(actor.subjectId,actor,'sandbox'),state=new URL(auth.authorizationUrl).searchParams.get('state');
  await f.service.completeDiscord(actor.subjectId,state,'999',{guildId:'10',roleIds:['20'],inviteUrl:'https://discord.gg/invite'});
  const begin=await f.service.beginDiscord('buyer'),oauth=new URL(begin.authorizationUrl).searchParams.get('state');
  await assert.rejects(f.service.completeDiscord('other',oauth,'111'),{code:'invalid_oauth_state'});await f.service.completeDiscord('buyer',oauth,'111');
  await assert.rejects(f.service.completeDiscord('buyer',oauth,'111'),{code:'invalid_oauth_state'});
  const a=await f.asset(),o=await f.offer(a,{benefits:[{type:'gallery',resourceId:'gallery'},{type:'discord_role',resourceId:'10:20',guildId:'10',roleId:'20'}]}),order=await f.checkout(o);
  await f.service.reconcile(scope,'connection',[f.evidence(order)]);await f.drain();await f.service.authorizeDownload('buyer',a.id);
  assert.equal((await f.store.transaction(tx=>tx.list('discordRole')))[0].status,'needs_membership');
  f.members.set('10:111',new Set());f.advance(1000000);await f.drain();assert.deepEqual(f.adds,['20']);
  const second=await f.checkout(o,'buyer','purchase-second');await f.service.reconcile(scope,'connection',[f.evidence(second,{captureId:'CAPTURE-2'})]);await f.drain();
  await f.service.reconcile(scope,'connection',[f.evidence(order,{status:'refunded',refundedMinor:1000})]);await f.drain();assert.deepEqual(f.removes,[]);
  await f.service.reconcile(scope,'connection',[f.evidence(second,{captureId:'CAPTURE-2',status:'reversed'})]);await f.drain();assert.deepEqual(f.removes,['20']);
});

test('Discord does not remove roles that predate management',async t=>{
  const f=await fixture(t);await f.verify();const setup=await f.service.beginDiscord(actor.subjectId,actor,'sandbox');await f.service.completeDiscord(actor.subjectId,new URL(setup.authorizationUrl).searchParams.get('state'),'999',{guildId:'10',roleIds:['20'],inviteUrl:'https://discord.gg/invite'});
  f.members.set('10:111',new Set(['20','unrelated']));const auth=await f.service.beginDiscord('buyer');await f.service.completeDiscord('buyer',new URL(auth.authorizationUrl).searchParams.get('state'),'111');
  const a=await f.asset(),o=await f.offer(a,{benefits:[{type:'discord_role',resourceId:'10:20',guildId:'10',roleId:'20'}]}),order=await f.checkout(o);
  await f.service.reconcile(scope,'connection',[f.evidence(order)]);await f.drain();await f.service.reconcile(scope,'connection',[f.evidence(order,{status:'reversed'})]);await f.drain();assert.deepEqual(f.removes,[]);assert.equal(f.members.get('10:111').has('unrelated'),true);
});

test('failed transactions roll back all writes and enforce database uniqueness',async t=>{
  const f=await fixture(t),customer=await f.service.customerProfile('buyer');
  await assert.rejects(f.store.transaction(tx=>{tx.insert('customer',{...customer,id:'new'},['unique']);tx.insert('customer',{...customer,id:'new2'},['unique']);}));
  assert.equal((await f.store.transaction(tx=>tx.list('customer'))).length,1);
});

test('passwordless customer sign-in hashes credentials, survives restart and rejects expired or reused links',async t=>{
 const f=await fixture(t);await f.service.beginEmailLogin('guest@example.test');await f.drain();const link=new URL(f.messages.at(-1).text),id=link.searchParams.get('id'),proof=link.searchParams.get('token');
 const session=await f.service.redeemEmailLogin(id,proof);f.restart();const subject=await f.service.customerSubject(session.token);assert.ok(subject.startsWith('customer-'));assert.deepEqual((await f.service.customerProfile(subject)).verifiedEmails,['guest@example.test']);
 await assert.rejects(f.service.redeemEmailLogin(id,proof),{code:'invalid_sign_in_link'});const stored=JSON.stringify(await f.store.transaction(tx=>tx.list('session')));assert.equal(stored.includes(session.token.split('.')[1]),false);
 await f.service.beginEmailLogin('another@example.test');await f.drain();const expired=new URL(f.messages.at(-1).text);f.advance(900001);await assert.rejects(f.service.redeemEmailLogin(expired.searchParams.get('id'),expired.searchParams.get('token')),{code:'invalid_sign_in_link'});
});

test('customer erasure revokes issued access while preserving required financial records',async t=>{
 const f=await fixture(t);await f.verify();const a=await f.asset(),o=await f.offer(a),order=await f.checkout(o);await f.service.reconcile(scope,'connection',[f.evidence(order)]);
 const authorized=await f.service.authorizeDownload('buyer',a.id);await f.service.eraseCustomer('buyer');
 await assert.rejects(f.service.download(a.id,new URL(authorized.url).searchParams.get('token')),{code:'access_denied'});
 await assert.rejects(f.service.customerProfile('buyer'),{code:'customer_erased'});
 const snapshot=await f.store.transaction(tx=>({payments:tx.list('payment'),customers:tx.list('customer'),grants:tx.list('entitlement')}));assert.equal(snapshot.payments.length,1);assert.equal(snapshot.payments[0].state,'completed');assert.deepEqual(snapshot.customers[0].verifiedEmails,[]);assert.ok(snapshot.grants.every(g=>g.state==='revoked'));
});

test('expired lifecycle leases fence stale checkout transactions and do not release a successor lease',async t=>{
 const f=await fixture(t),scopeKey=JSON.stringify([scope.deploymentId,scope.ownerId,scope.environment]);
 await f.store.withLock(scope,async()=>{
  f.store.db.prepare('UPDATE commerce_locks SET token=?,expires=? WHERE scope=?').run('successor',Date.now()+90000,scopeKey);
  await assert.rejects(f.store.transaction(tx=>tx.list('checkout')),{code:'connection_lock_lost'});
 });
 assert.equal(f.store.db.prepare('SELECT token FROM commerce_locks WHERE scope=?').get(scopeKey).token,'successor');
});

test('Discord setup tokens stay in the encrypted port and server/role selection requires creator authority',async t=>{
 const f=await fixture(t),tokens=new Map();f.ports.discordTokens={write:async(_scope,value)=>{tokens.set('ref',value);return 'ref';},read:async ref=>tokens.get(ref),revoke:async ref=>tokens.delete(ref)};
 f.ports.discord.guilds=async()=>[{id:'10',name:'Creator server'}];f.ports.discord.roles=async()=>[{id:'20',name:'Supporter'}];
 const begin=await f.service.beginDiscord(actor.subjectId,actor,'sandbox'),state=new URL(begin.authorizationUrl).searchParams.get('state');
 assert.equal((await f.service.discordFlow(actor.subjectId,state)).creator,true);
 const setup=await f.service.completeDiscord(actor.subjectId,state,'999');assert.equal(JSON.stringify(setup).includes('SECRET'),false);assert.equal(tokens.size,1);
 await assert.rejects(f.service.discordSetupRoles({ownerId:'creator',subjectId:'other'},setup.creatorSessionId,'10'),{code:'forbidden'});
 assert.deepEqual(await f.service.discordSetupRoles(actor,setup.creatorSessionId,'10'),[{id:'20',name:'Supporter'}]);
 await f.service.configureDiscordSetup(actor,setup.creatorSessionId,{guildId:'10',roleIds:['20'],inviteUrl:'https://discord.gg/invite'});assert.equal(tokens.size,0);assert.equal((await f.service.creatorHistory(actor)).guilds[0].roleLabels['20'],'Supporter');
});

test('transaction handles cannot mutate records after their atomic callback ends',async t=>{
 const f=await fixture(t);let escaped;await f.store.transaction(tx=>{escaped=tx;});
 assert.throws(()=>escaped.list('customer'),{code:'commerce_transaction_ended'});
 assert.throws(()=>escaped.remove('customer','nonexistent'),{code:'commerce_transaction_ended'});
});

test('superseded offer prices cannot create new orders, while an earlier idempotent checkout stays recoverable',async t=>{
 const f=await fixture(t);await f.verify();const a=await f.asset(),first=await f.offer(a),order=await f.checkout(first);
 const next=await f.offer(a,{offerId:first.offerId,amountMinor:2000});
 await assert.rejects(f.service.checkout('buyer',first.id,'new-stale-checkout'),{code:'offer_not_found'});
 assert.equal((await f.service.checkout('buyer',first.id,'purchase-12345')).id,order.id);
 await assert.rejects(f.service.setOfferPublished(actor,first.id,true),{code:'offer_version_superseded'});
 assert.equal((await f.service.storefront('creator','sandbox'))[0].amountMinor,next.amountMinor);
 f.ports.connection=async()=>{throw new CommerceError('payment_connection_unavailable',409);};
 assert.equal((await f.service.storefront('creator','sandbox'))[0].availableForCheckout,false);
});

test('deployment offer eligibility gates both public discovery and new checkout',async t=>{
 const f=await fixture(t);await f.verify();const a=await f.asset(),o=await f.offer(a);
 f.ports.assertOfferEligible=async()=>{throw new CommerceError('offer_not_eligible',403);};
 assert.deepEqual(await f.service.storefront('creator','sandbox'),[]);
 await assert.rejects(f.service.checkout('buyer',o.id,'blocked-offer-checkout'),{code:'offer_not_eligible'});
});

test('capture rechecks eligibility after checkout and does not charge a policy-held offer',async t=>{
 const f=await fixture(t);await f.verify();const a=await f.asset(),o=await f.offer(a),order=await f.checkout(o);
 f.ports.assertOfferEligible=async()=>{throw new CommerceError('offer_not_eligible',403);};await f.service.capture('buyer',order.id);await f.drain();
 assert.equal(f.captureCalls,0);assert.equal((await f.service.purchases('buyer')).length,0);
});

test('revocation during an in-flight Discord grant converges without retaining paid access',async t=>{
 const f=await fixture(t),customer=await f.verify();
 await f.store.transaction(tx=>{tx.put('customer',{...customer,discordUserId:'discord-user'});tx.insert('guild',{...scope,id:'guild-config',guildId:'guild',roleIds:['role'],inviteUrl:'https://discord.gg/test',createdAt:f.service.now(),updatedAt:f.service.now()});});
 f.members.set('guild:discord-user',new Set());
 const grant=await f.service.manualGrant(actor,{customerId:customer.id,environment:'sandbox',benefit:{type:'discord_role',resourceId:'role',guildId:'guild',roleId:'role'},reason:'Purchase access'});
 let release,entered;const blocked=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),add=f.ports.discord.addRole;
 f.ports.discord.addRole=async(...args)=>{entered();await blocked;return add(...args);};
 const first=f.service.runNextJob('grant-worker');await started;
 let second;try{await f.service.revoke(actor,grant.id,'Refund');second=f.service.runNextJob('revoke-worker');await new Promise(setImmediate);}finally{release();await first;await second;}
 await f.drain();f.advance(100000);await f.drain();
 assert.equal(f.members.get('guild:discord-user').has('role'),false);
 assert.ok((await f.store.transaction(tx=>tx.list('discordRole'))).every(r=>!r.desired&&!r.actual));
});

test('external payment mappings use the current proven version and preserve prior purchases',async t=>{
 const f=await fixture(t),a=await f.asset(),b=await f.asset('new.png',Buffer.from('new version'));
 const first=await f.offer(a,{external:{url:'https://www.paypal.com/ncp/payment/LINK',mappingId:'SKU-1'}});
 async function observe(captureId,mappingId='SKU-1'){
  const evidence={captureId,merchantId:'merchant',currency:'USD',paidMinor:1000,refundedMinor:0,status:'completed',updatedAt:f.service.now(),buyerEmail:'purchase@example.test',mappingId};
  await f.store.acceptEvent({connection:{...scope,id:'connection'},eventId:captureId,eventType:'PAYMENT.CAPTURE.COMPLETED',rawBody:Buffer.from(JSON.stringify({id:captureId})),receivedAt:f.service.now()});
  const event=(await f.store.transaction(tx=>tx.list('event'))).find(e=>e.eventId===captureId);
  const [payment]=await f.service.reconcile(scope,'connection',[evidence],event.id);f.providerEvidence.set(captureId,[evidence]);return payment;
 }
 const oldPayment=await observe('OLD');await f.service.validateExternalMapping(actor,first.id,oldPayment.id);await f.drain();
 const second=await f.offer(b,{offerId:first.offerId,external:{url:'https://www.paypal.com/ncp/payment/LINK2',mappingId:'SKU-2'}});
 const newPayment=await observe('NEW','SKU-2');await f.service.validateExternalMapping(actor,second.id,newPayment.id);await f.drain();
 const purchases=await f.store.transaction(tx=>tx.list('purchase'));
 assert.equal(purchases.find(p=>p.paymentId===oldPayment.id).offerVersionId,first.id);
 assert.equal(purchases.find(p=>p.paymentId===newPayment.id).offerVersionId,second.id);
 const delayed=await observe('DELAYED-OLD-SKU');assert.equal((await f.store.transaction(tx=>tx.get('purchase',tx.list('purchase').find(p=>p.paymentId===delayed.id).id))).offerVersionId,first.id);
 await f.service.reconcile(scope,'connection',[{...f.providerEvidence.get('OLD')[0],status:'refunded',refundedMinor:1000}]);
 assert.equal((await f.store.transaction(tx=>tx.get('payment',oldPayment.id))).offerVersionId,first.id);
 const other=await f.offer(a,{slug:'another-product',external:{url:'https://www.paypal.com/ncp/payment/OTHER',mappingId:'SKU-2'}});
 await assert.rejects(f.service.validateExternalMapping(actor,other.id,newPayment.id),{code:'external_mapping_conflict'});
});

test('offer publication retries return the exact version and reject changed reviewed values',async t=>{
 const f=await fixture(t),asset=await f.asset(),first=await f.offer(asset,{requestId:'reviewed-offer-request'});
 const repeated=await f.offer(asset,{requestId:'reviewed-offer-request'});assert.equal(repeated.id,first.id);assert.equal((await f.store.transaction(tx=>tx.list('offer'))).length,1);
 await assert.rejects(f.offer(asset,{requestId:'reviewed-offer-request',amountMinor:2000}),{code:'idempotency_conflict'});
});

test('offers and checkouts keep explicit seller connections and reject cross-connection evidence',async t=>{const f=await fixture(t),ready=new Set(['seller-a','seller-b']);f.ports.connection=async(_owner,_environment,id)=>{if(!id||!ready.has(id))throw new CommerceError('payment_connection_unavailable',409);return {id,merchantId:'merchant'};};const file=await f.asset(),a=await f.offer(file,{slug:'gallery-a',connectionId:'seller-a'}),b=await f.offer(file,{slug:'gallery-b',connectionId:'seller-b'});assert.equal(a.connectionId,'seller-a');assert.equal(b.connectionId,'seller-b');const shop=await f.service.storefront('creator','sandbox');assert.ok(shop.every(o=>o.availableForCheckout));assert.ok(shop.every(o=>o.connectionId===undefined));await f.verify();const order=await f.checkout(a);assert.equal(order.connectionId,'seller-a');await assert.rejects(f.service.reconcile(scope,'seller-b',[f.evidence(order)]),{code:'payment_connection_mismatch'});assert.equal((await f.store.transaction(tx=>tx.list('payment'))).length,0);await f.service.reconcile(scope,'seller-a',[f.evidence(order)]);await assert.rejects(f.service.reconcile(scope,'seller-b',[f.evidence(order,{status:'refunded',refundedMinor:1000})]),{code:'payment_connection_mismatch'});assert.equal((await f.service.purchases('buyer'))[0].payment.state,'completed');ready.delete('seller-a');const after=await f.service.storefront('creator','sandbox');assert.equal(after.find(o=>o.id===a.id).availableForCheckout,false);assert.equal(after.find(o=>o.id===b.id).availableForCheckout,true);await assert.rejects(f.service.checkout('buyer',a.id,'new-order-for-a'),{code:'payment_connection_unavailable'});const other=await f.checkout(b,'buyer','new-order-for-b');assert.equal(other.connectionId,'seller-b');assert.equal((await f.service.purchases('buyer')).length,1);});

test('SQLite preserves legacy connections while migrating to multiple distinct apps',async t=>{const f=await fixture(t),a={...scope,id:'app-a',clientId:'client-a',revision:1,retiredCredentialReferences:[],state:'configured',acceptsCheckouts:true},b={...a,id:'app-b',clientId:'client-b',label:'Second account'};await f.store.withLock(scope,()=>f.store.save(a,0,{actorId:'owner',action:'connect',at:'now'}));const {DatabaseSync}=await import('node:sqlite'),legacy=new DatabaseSync(f.path);legacy.exec('DROP INDEX commerce_connection_client;CREATE UNIQUE INDEX commerce_connection_active ON commerce_connections(deployment,owner,environment) WHERE active=1');legacy.close();f.restart();await f.store.withLock(scope,()=>f.store.save(b,0,{actorId:'owner',action:'connect',at:'now'}));assert.equal((await f.store.listConnections('creator')).length,2);assert.equal(await f.store.find(scope),undefined);await assert.rejects(f.store.withLock(scope,()=>f.store.save({...a,id:'duplicate'},0,{actorId:'owner',action:'connect',at:'now'})));f.restart();assert.equal((await f.store.get('deployment','app-a')).clientId,'client-a');assert.equal((await f.store.get('deployment','app-b')).label,'Second account');});

test('an older host connection resolver cannot silently ignore an explicit seller',async t=>{const f=await fixture(t),file=await f.asset();await assert.rejects(f.offer(file,{connectionId:'another-seller'}),{code:'payment_connection_mismatch'});assert.equal((await f.store.transaction(tx=>tx.list('offer'))).length,0);});

test('subscription renewals expire by paid calendar period while a one-time purchase retains ongoing access',async t=>{
 const f=await fixture(t),file=await f.asset();await f.verify();
 f.provider.createOrder=async order=>({orderId:'I-'+order.id,planId:'PLAN',merchantId:'merchant',approvalUrl:'https://www.sandbox.paypal.com/approve'});
 let cancelled=0;f.provider.cancelSubscription=async()=>{cancelled++;};
 const plan=await f.offer(file,{slug:'monthly',billing:'month'}),order=await f.checkout(plan);
 assert.equal(order.billing,'month');assert.equal(order.providerPlanId,'PLAN');
 const evidence=f.evidence(order,{paidAt:'2026-11-01T12:00:00Z',subscriptionInterval:'month',subscriptionPlanId:'PLAN'});
 await f.service.reconcile(scope,'connection',[evidence,evidence]);assert.equal((await f.service.purchases('buyer')).length,1);
 assert.equal((await f.service.myAccess('buyer')).entitlements[0].endsAt,'2026-12-01T12:00:00.000Z');
 await assert.rejects(f.service.cancelSubscription('other',order.id),{code:'checkout_not_found'});await assert.rejects(f.service.eraseCustomer('buyer'),{code:'cancel_subscriptions_before_erasure'});
 await f.service.cancelSubscription('buyer',order.id);assert.equal(cancelled,1);assert.ok((await f.service.myAccess('buyer')).assets.length);
 f.advance(31*86400000);assert.equal((await f.service.myAccess('buyer')).assets.length,0);
 const one=await f.offer(file,{slug:'ongoing'}),buy=await f.checkout(one,'buyer','one-time-12345');
 await f.service.reconcile(scope,'connection',[f.evidence(buy,{captureId:'ONE-TIME'})]);
 f.advance(366*86400000);assert.equal((await f.service.myAccess('buyer')).assets.length,1);
});
test('subscription evidence must match its immutable provider plan, interval and payment time',async t=>{
 const f=await fixture(t),file=await f.asset();await f.verify();f.provider.createOrder=async order=>({orderId:'I-'+order.id,planId:'PLAN',merchantId:'merchant',approvalUrl:'https://www.sandbox.paypal.com/approve'});
 const plan=await f.offer(file,{billing:'year'}),order=await f.checkout(plan);
 for(const patch of [{subscriptionPlanId:'OTHER',subscriptionInterval:'year',paidAt:'2026-11-01T12:00:00Z'},{subscriptionPlanId:'PLAN',subscriptionInterval:'month',paidAt:'2026-11-01T12:00:00Z'},{subscriptionPlanId:'PLAN',subscriptionInterval:'year'}]){await f.service.reconcile(scope,'connection',[f.evidence(order,patch)]);assert.equal((await f.service.myAccess('buyer')).assets.length,0);}
 const paid=f.evidence(order,{subscriptionPlanId:'PLAN',subscriptionInterval:'year',paidAt:'2026-11-01T12:00:00Z'});await f.service.reconcile(scope,'connection',[paid]);assert.equal((await f.service.myAccess('buyer')).entitlements[0].endsAt,'2027-11-01T12:00:00.000Z');
 await f.service.reconcile(scope,'connection',[{...paid,status:'refunded',refundedMinor:1000}]);assert.equal((await f.service.myAccess('buyer')).assets.length,0);
});

test('creator gifts require the recipient verified email, never charge PayPal, and revoke independently',async t=>{
 const f=await fixture(t),file=await f.asset(),offer=await f.offer(file);let creates=0;f.provider.createOrder=async()=>{creates++;throw Error('No payment expected');};
 const gift=await f.service.giftOffer(actor,{offerVersionId:offer.id,recipientEmail:'recipient@example.test',requestId:'gift-one-time-123'});
 assert.equal((await f.service.giftOffer(actor,{offerVersionId:offer.id,recipientEmail:'recipient@example.test',requestId:'gift-one-time-123'})).id,gift.id);
 await assert.rejects(f.service.giftOffer({subjectId:'other',ownerId:'creator'},{offerVersionId:offer.id,recipientEmail:'recipient@example.test',requestId:'unauthorized-gift'}),{code:'forbidden'});
 await f.verify('wrong','wrong@example.test');assert.equal((await f.service.gifts('wrong')).length,0);assert.equal((await f.service.myAccess('wrong')).assets.length,0);
 await f.verify('recipient','recipient@example.test');assert.equal((await f.service.gifts('recipient'))[0].state,'claimed');assert.equal((await f.service.myAccess('recipient')).assets.length,1);assert.equal(creates,0);assert.equal((await f.store.transaction(tx=>tx.list('payment'))).length,0);
 const second=await f.service.giftOffer(actor,{offerVersionId:offer.id,recipientEmail:'recipient@example.test',requestId:'second-gift-123'});await f.service.gifts('recipient');
 await f.service.revokeGift(actor,gift.id);assert.equal((await f.service.myAccess('recipient')).assets.length,1);await f.service.revokeGift(actor,second.id);assert.equal((await f.service.myAccess('recipient')).assets.length,0);
 await f.drain();assert.ok(f.messages.some(m=>m.subject==='You received a collection gift'));
});
test('subscription gifts start a fixed duration on claim and never renew; pending revocation prevents claiming',async t=>{
 const f=await fixture(t),file=await f.asset(),offer=await f.offer(file,{billing:'month'});
 await assert.rejects(f.service.giftOffer(actor,{offerVersionId:offer.id,recipientEmail:'recipient@example.test',requestId:'missing-duration'}),{code:'invalid_gift_duration'});
 const pending=await f.service.giftOffer(actor,{offerVersionId:offer.id,recipientEmail:'recipient@example.test',months:2,requestId:'fixed-duration-123'});
 f.advance(10*86400000);await f.verify('recipient','recipient@example.test');let gifts=await f.service.gifts('recipient');assert.equal(gifts[0].endsAt,'2027-01-11T12:00:00.000Z');
 f.advance(62*86400000);assert.equal((await f.service.myAccess('recipient')).assets.length,0);gifts=await f.service.gifts('recipient');assert.equal(gifts[0].endsAt,'2027-01-11T12:00:00.000Z');
 const revoked=await f.service.giftOffer(actor,{offerVersionId:offer.id,recipientEmail:'other@example.test',months:1,requestId:'revoke-pending-123'});await f.service.revokeGift(actor,revoked.id);await f.verify('other','other@example.test');assert.equal((await f.service.gifts('other')).length,0);
});

test('reviewed subscription content updates reach paid and gifted subscribers without changing price or one-time snapshots',async t=>{
 const f=await fixture(t),a=await f.asset('a.png'),b=await f.asset('b.png');await f.verify();
 f.provider.createOrder=async order=>({orderId:'I-'+order.id,planId:'PLAN',merchantId:'merchant',approvalUrl:'https://www.sandbox.paypal.com/approve'});
 const plan=await f.offer(a,{slug:'membership',billing:'month'}),order=await f.checkout(plan);
 await f.service.reconcile(scope,'connection',[f.evidence(order,{paidAt:f.service.now(),subscriptionInterval:'month',subscriptionPlanId:'PLAN'})]);
 const one=await f.offer(a,{slug:'one-time'}),buy=await f.checkout(one,'buyer','one-time-12345');await f.service.reconcile(scope,'connection',[f.evidence(buy,{captureId:'ONE'})]);
 await f.service.giftOffer(actor,{offerVersionId:plan.id,recipientEmail:'gift@example.test',months:3,requestId:'subscription-gift'});await f.verify('gifted','gift@example.test');await f.service.gifts('gifted');
 const updated=await f.offer(b,{offerId:plan.offerId,slug:'membership',billing:'month',amountMinor:2000});
 const purchases=await f.service.purchases('buyer'),sub=purchases.find(p=>p.offer.billing),ongoing=purchases.find(p=>!p.offer.billing);
 assert.equal(sub.offer.amountMinor,1000);assert.equal(sub.payment.paidMinor,1000);assert.equal(sub.contentOffer.id,updated.id);assert.deepEqual(sub.entitlements.filter(g=>g.state==='active'&&g.benefit.type==='gallery')[0].assetIds,[b.id]);assert.deepEqual(ongoing.offer.files,[a.id]);assert.deepEqual((await f.service.gifts('gifted'))[0].contentOffer.files,[b.id]);
 const renewal=f.evidence(order,{captureId:'RENEWAL',paidAt:f.service.now(),subscriptionInterval:'month',subscriptionPlanId:'PLAN'});await f.service.reconcile(scope,'connection',[renewal]);const renewed=(await f.service.purchases('buyer')).find(p=>p.payment.providerPaymentId==='RENEWAL');assert.equal(renewed.payment.paidMinor,1000);assert.deepEqual(renewed.contentOffer.files,[b.id]);
});

test('collection buyers follow current contents on return while their original price, terms and download rights stay pinned',async t=>{
 const f=await fixture(t),a=await f.asset('First image'),b=await f.asset('Added image');await f.verify();
 const original=await f.offer(a,{collectionRoots:['collection'],contentSourceRevision:'saved-1',benefits:[{type:'gallery',resourceId:'collection'},{type:'download',resourceId:a.id},{type:'package',resourceId:'collection'}]});
 const order=await f.checkout(original);await f.service.reconcile(scope,'connection',[f.evidence(order)]);
 const {id,deploymentId,ownerId,environment,createdAt,updatedAt,...input}=b;let revision='saved-2';
 f.ports.prepareCollectionContents=async offer=>offer.contentSourceRevision===revision?undefined:{revision,collectionRoots:['collection'],galleryIds:['collection'],title:'Revised collection',description:'Latest description',assets:[{...input,label:'Edited image'}]};
 let purchases=await f.service.purchases('buyer'),purchase=purchases[0];assert.equal(purchase.offer.amountMinor,1000);assert.equal(purchase.offer.terms,original.terms);assert.equal(purchase.offer.id,original.id);assert.equal(purchase.contentOffer.title,'Revised collection');assert.notDeepEqual(purchase.contentOffer.files,original.files);
 assert.ok(purchase.entitlements.some(g=>g.state==='active'&&g.benefit.type==='download'&&g.assetIds[0]===purchase.contentOffer.files[0]));
 await f.service.purchases('buyer');assert.equal((await f.store.transaction(tx=>tx.list('offer'))).length,2);const archiveGrant=purchase.entitlements.find(g=>g.state==='active'&&g.benefit.type==='package');assert.ok(archiveGrant);await f.drain();assert.equal((await f.store.transaction(tx=>tx.list('package').find(p=>p.assetId===archiveGrant.assetIds[0]))).state,'ready');
 await f.service.setOfferPublished(actor,original.id,false);assert.equal((await f.service.storefront('creator','sandbox')).length,0);
 revision='saved-3';purchases=await f.service.purchases('buyer');assert.equal(purchases[0].contentOffer.contentSourceRevision,'saved-3');assert.equal((await f.service.storefront('creator','sandbox')).length,0,'content refresh must not restart sales');
 await f.service.reconcile(scope,'connection',[f.evidence(order,{status:'refunded',refundedMinor:1000})]);assert.equal((await f.service.myAccess('buyer')).assets.length,0);
});
