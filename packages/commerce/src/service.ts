import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { CommerceError, currencyExponent, type Audit, type Benefit, type Checkout, type Claim, type CommerceStore,
  type CommerceTransaction, type Customer, type DeliveryJob, type Environment, type Offer, type Payment,
  type PrivateAsset, type RecordBase, type Scope } from './model.js';

export interface CreatorActor { subjectId: string; ownerId: string; }
export interface PaymentEvidence {
  captureId: string; orderId?: string; reference?: string; mappingId?: string; merchantId: string;
  currency: string; paidMinor: number; refundedMinor: number; status: 'pending' | 'completed' | 'failed' | 'partially_refunded' | 'refunded' | 'reversed';
  updatedAt: string; buyerEmail?: string; unsupported?: boolean;
  refunds?: { id: string; amountMinor: number; state: string }[]; dispute?: string;
}
export interface CommerceProvider {
  createOrder(order: Checkout, offer: Offer): Promise<{ orderId: string; approvalUrl: string; merchantId: string }>;
  capture(order: Checkout): Promise<void>;
  orderStatus?(order: Checkout): Promise<'pending' | 'approved' | 'failed'>;
  reconcile(scope: Scope, connectionId: string, reference: { orderId?: string; captureId?: string; eventId?: string; eventType?: string; payload?: string }): Promise<PaymentEvidence[]>;
}
export interface CommerceAssets {
  read(asset: PrivateAsset): Promise<Uint8Array>;
  putPackage(scope: Scope, id: string, files: { name: string; bytes: Uint8Array }[], maxBytes: number): Promise<{ objectId: string; checksum: string; byteLength: number }>;
  /** Policy/storage quota, checked before building archives. */
  limitBytes(ownerId: string): Promise<number>;
}
export interface CommerceDiscord {
  authorizationUrl(state: string, creator: boolean): string;
  installUrl(): string;
  exchange(code: string): Promise<{ userId: string; accessToken: string }>;
  validateGuild(accessToken: string, guildId: string, roleIds: string[]): Promise<void>;
  guilds?(accessToken: string): Promise<{ id: string; name: string }[]>;
  roles?(guildId: string): Promise<{ id: string; name: string }[]>;
  validateInvite?(guildId: string, inviteUrl: string): Promise<void>;
  member(guildId: string, userId: string): Promise<{ roles: string[] } | undefined>;
  validateRoles(guildId: string, roleIds: string[]): Promise<void>;
  addRole(guildId: string, userId: string, roleId: string): Promise<void>;
  removeRole(guildId: string, userId: string, roleId: string): Promise<void>;
}
export interface CommercePorts {
  store: CommerceStore; provider: CommerceProvider; assets: CommerceAssets;
  publicBaseUrl: string; tokenKey: string; now?: () => Date;
  authorizeCreator(actor: CreatorActor): Promise<void>;
  assertEligible(scope: Scope): Promise<void>;
  assertOfferEligible?(scope:Scope,offer:{offerId?:string;files:readonly string[];benefits:readonly Benefit[]}):Promise<void>;
  /** Must reject disabled/disconnected/draining connections and enforce app migration deadlines. */
  connection(ownerId: string, environment: Environment): Promise<{ id: string; merchantId?: string }>;
  withConnectionLock<T>(scope: Scope, operation: () => Promise<T>): Promise<T>;
  withStorageLock?<T>(scope: Scope, operation: () => Promise<T>): Promise<T>;
  markVerified(scope: Scope, connectionId: string, merchantId: string, at: string): Promise<void>;
  bindMerchant?(scope: Scope, connectionId: string, merchantId: string): Promise<void>;
  mail: { send(input: { to: string; subject: string; text: string; idempotencyKey: string }): Promise<void> };
  discord?: CommerceDiscord;
  reconciliation?:{batchSize:number;recentPaymentDays:number};
  discordTokens?: {
    write(scope: Scope, value: string): Promise<string>;
    read(reference: string): Promise<string | undefined>;
    revoke(reference: string): Promise<void>;
  };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const key = (...values: unknown[]) => hash(JSON.stringify(values));
const email = (value: string) => {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new CommerceError('invalid_email');
  return value.trim().toLowerCase();
};
const same = (value: RecordBase, scope: Scope) => value.deploymentId === scope.deploymentId && value.ownerId === scope.ownerId && value.environment === scope.environment;
const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const isActive = (grant: import('./model.js').Entitlement, at: string) => grant.state === 'active' && grant.startsAt <= at && (!grant.endsAt || grant.endsAt > at);

export class CommerceService {
  readonly store: CommerceStore;
  private readonly baseUrl: string;
  constructor(readonly ports: CommercePorts) {
    this.store = ports.store;
    const url = new URL(ports.publicBaseUrl);
    if ((url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) || url.username || url.password || url.search || url.hash)
      throw new CommerceError('invalid_commerce_base_url');
    if (ports.tokenKey.length < 32) throw new CommerceError('commerce_token_key_required');
    if(ports.reconciliation&&(!Number.isSafeInteger(ports.reconciliation.batchSize)||ports.reconciliation.batchSize<1||ports.reconciliation.batchSize>1000||!Number.isSafeInteger(ports.reconciliation.recentPaymentDays)||ports.reconciliation.recentPaymentDays<1||ports.reconciliation.recentPaymentDays>365))throw new CommerceError('invalid_reconciliation_limits');
    this.baseUrl = url.href.replace(/\/$/, '');
  }
  now() { return (this.ports.now?.() ?? new Date()).toISOString(); }
  private scope(ownerId: string, environment: Environment): Scope {
    if (!ownerId || !['sandbox', 'live'].includes(environment)) throw new CommerceError('invalid_scope');
    return { deploymentId: this.store.deploymentId, ownerId, environment };
  }
  private base(scope: Scope, id: string = randomUUID()): RecordBase { const at = this.now(); return { deploymentId: scope.deploymentId, ownerId: scope.ownerId, environment: scope.environment, id, createdAt: at, updatedAt: at }; }
  private audit(tx: CommerceTransaction, scope: Scope, actorId: string, action: string, resourceId: string, reason?: string) {
    const record: Audit = { ...this.base(scope), actorId, action, resourceId, ...(reason ? { reason: reason.slice(0, 1000) } : {}) }; tx.insert('audit', record);
  }
  private queue(tx: CommerceTransaction, scope: Scope, kind: DeliveryJob['kind'], referenceId: string, dedup?: string) {
    if(kind==='discord'&&!tx.list('entitlement').some(g=>g.customerId===referenceId&&same(g,scope)&&g.benefit.type==='discord_role')&&!tx.list('discordRole').some(r=>r.customerId===referenceId&&same(r,scope)))return false;
    const id = dedup ? key('job', scope.deploymentId, scope.ownerId, scope.environment, kind, dedup) : randomUUID();
    const prior=tx.get('job',id);
    if(prior){if(kind==='capture'&&['pending','failed'].includes(prior.state)){prior.state='pending';prior.dueAt=this.now();prior.lastError=undefined;tx.put('job',prior);}return false;}
    tx.insert('job', { ...this.base(scope, id), kind, referenceId, state: 'pending', attempts: 0, dueAt: this.now() });
    return true;
  }
  private rate(tx: CommerceTransaction, subject: string, action: string, limit: number, seconds: number) {
    const id = key('rate', action, subject), at = this.now(), prior = tx.get('rate', id);
    const windowAt = prior && Date.parse(prior.windowAt) + seconds * 1000 > Date.parse(at) ? prior.windowAt : at;
    const count = windowAt === prior?.windowAt ? prior.count + 1 : 1;
    tx.put('rate', { ...this.base(this.scope('system', 'live'), id), count, windowAt });
    return count <= limit;
  }
  async rateLimit(subject: string, action: string, limit = 20, seconds = 60) {
    if (!await this.store.transaction(tx => this.rate(tx, subject, action, limit, seconds))) throw new CommerceError('rate_limited', 429);
  }
  async operationalIssue(scope:Scope,code:string,correlationId:string){
    await this.store.transaction(tx=>{if(this.rate(tx,key(scope.ownerId,scope.environment,code),'operational_alert',1,900)){
      this.audit(tx,scope,'system','operations.'+code,correlationId,code);
      this.queue(tx,scope,'creator_notice',correlationId,key('operational-alert',scope.ownerId,Math.floor(Date.parse(this.now())/86400000)));
    }});
  }
  private token(purpose: string, id: string) { return createHmac('sha256', this.ports.tokenKey).update(JSON.stringify([this.store.deploymentId, purpose, id])).digest('base64url'); }
  private customer(tx: CommerceTransaction, subjectId: string): Customer {
    if (!subjectId) throw new CommerceError('authentication_required', 401);
    const id = key('customer', subjectId); const existing = tx.get('customer', id);
    if (existing) { if (existing.erasedAt) throw new CommerceError('customer_erased', 410); return existing; }
    const customer: Customer = { ...this.base(this.scope(id, 'live'), id), subjectId, verifiedEmails: [] };
    tx.insert('customer', customer, [key('customer-subject', subjectId)]); return customer;
  }
  async customerProfile(subjectId: string) { return this.store.transaction(tx => this.customer(tx, subjectId)); }
  async eraseCustomer(subjectId: string) {
    await this.store.transaction(tx => {
      const customer = this.customer(tx, subjectId), previousSubject = customer.subjectId;
      customer.erasedAt = this.now(); customer.subjectId = 'erased'; customer.verifiedEmails = []; customer.discordUserId = undefined; tx.put('customer', customer);
      const scopes = new Map<string, Scope>();
      for (const grant of tx.list('entitlement').filter(g => g.customerId === customer.id)) { grant.state = 'revoked'; tx.put('entitlement', grant); scopes.set(key(grant.ownerId,grant.environment),grant); }
      for (const purchase of tx.list('purchase').filter(p => p.customerId === customer.id)) {
        purchase.buyerEmail = undefined; tx.put('purchase', purchase);
        for (const claim of tx.list('claim').filter(c => c.purchaseId === purchase.id)) tx.remove('claim', claim.id);
      }
      for (const proof of tx.list('emailProof').filter(p => p.customerId === customer.id)) tx.remove('emailProof', proof.id);
      for (const state of tx.list('oauth').filter(p => p.customerId === customer.id)) tx.remove('oauth', state.id);
      for (const session of tx.list('session').filter(p => p.customerId === customer.id)) tx.remove('session', session.id);
      for (const login of tx.list('login').filter(p => p.subjectId === previousSubject)) tx.remove('login', login.id);
      for (const scope of scopes.values()) { this.queue(tx, scope, 'discord', customer.id); this.audit(tx, scope, 'customer', 'customer.erase', customer.id, 'Financial records retained under configured policy'); }
    }); return { erased: true };
  }
  async beginEmailLogin(address: string) {
    const normalized = email(address); await this.rateLimit(hash(normalized), 'email_login', 5, 3600);
    await this.store.transaction(tx => {
      const matches = tx.list('customer').filter(c => !c.erasedAt && c.verifiedEmails.includes(normalized));
      // Ambiguous recovery never silently chooses or merges application accounts.
      if (matches.length > 1) return;
      const id = randomUUID(), subjectId = matches[0]?.subjectId ?? 'customer-' + randomUUID();
      tx.insert('login', { ...this.base(this.scope('customer-auth', 'live'), id), subjectId, email: normalized,
        tokenHash: hash(this.token('login', id)), expiresAt: new Date(Date.parse(this.now()) + 900000).toISOString() });
      this.queue(tx, this.scope('customer-auth', 'live'), 'login_email', id);
    }); return { queued: true };
  }
  async redeemEmailLogin(id: string, token: string) {
    return this.store.transaction(tx => { const login = tx.get('login', id);
      if (!login || login.consumedAt || login.expiresAt <= this.now() || !safeEqual(login.tokenHash, hash(token))) throw new CommerceError('invalid_sign_in_link', 403);
      const customer = this.customer(tx, login.subjectId); customer.verifiedEmails = [...new Set([...customer.verifiedEmails, login.email])]; tx.put('customer', customer);
      login.consumedAt = this.now(); tx.put('login', login);
      const sessionId = randomUUID(), secret = this.token('session', sessionId), expiresAt = new Date(Date.parse(this.now()) + 86400000).toISOString();
      tx.insert('session', { ...this.base(this.scope(customer.id, 'live'), sessionId), customerId: customer.id, tokenHash: hash(secret), expiresAt });
      return { token: sessionId + '.' + secret, expiresAt };
    });
  }
  async customerSubject(credential: string): Promise<string | undefined> {
    if (credential.length > 1000) return undefined;
    const [id, token, extra] = credential.split('.'); if (!id || !token || extra) return undefined;
    return this.store.transaction(tx => { const session = tx.get('session', id); if (!session || session.expiresAt <= this.now() || !safeEqual(session.tokenHash, hash(token))) return undefined;
      const customer = tx.get('customer', session.customerId); return customer && !customer.erasedAt ? customer.subjectId : undefined; });
  }
  async beginEmailVerification(subjectId: string, address: string) {
    const normalized = email(address); await this.rateLimit(subjectId, 'verify_email', 5, 3600);
    await this.store.transaction(tx => {
      const customer = this.customer(tx, subjectId), id = randomUUID();
      tx.insert('emailProof', { ...this.base(this.scope(subjectId, 'live'), id), customerId: customer.id, email: normalized,
        tokenHash: hash(this.token('email', id)), expiresAt: new Date(Date.parse(this.now()) + 3600000).toISOString() });
      this.queue(tx, customer, 'verify_email', id);
    });
    return { queued: true };
  }
  async verifyEmail(subjectId: string, id: string, token: string) {
    await this.rateLimit(subjectId, 'email_redeem', 10, 3600);
    return this.store.transaction(tx => {
      const customer = this.customer(tx, subjectId), proof = tx.get('emailProof', id);
      if (!proof || proof.customerId !== customer.id || proof.consumedAt || proof.expiresAt <= this.now() || !safeEqual(proof.tokenHash, hash(token)))
        throw new CommerceError('invalid_email_proof', 403);
      proof.consumedAt = this.now(); tx.put('emailProof', proof);
      customer.verifiedEmails = [...new Set([...customer.verifiedEmails, proof.email])]; tx.put('customer', customer);
      return { verified: true };
    });
  }
  async registerAsset(actor: CreatorActor, environment: Environment, input: Omit<PrivateAsset, keyof RecordBase>) {
    await this.ports.authorizeCreator(actor); const scope = this.scope(actor.ownerId, environment);
    if (!input.objectId || !Number.isSafeInteger(input.byteLength) || input.byteLength < 0 || !/^[a-f0-9]{64}$/.test(input.checksum)) throw new CommerceError('invalid_asset');
    const asset: PrivateAsset = { ...structuredClone(input), ...this.base(scope) };
    return this.store.transaction(tx => { if(input.source){const existing=tx.list('asset').find(a=>same(a,scope)&&a.source?.workId===input.source!.workId&&a.source?.assetId===input.source!.assetId&&a.source?.checksum===input.source!.checksum&&a.objectId===input.objectId&&a.checksum===input.checksum&&a.state==='available');if(existing)return existing;}tx.insert('asset', asset); this.audit(tx, scope, actor.subjectId, 'asset.register', asset.id);return asset; });
  }
  async setAssetAvailability(actor: CreatorActor, id: string, available: boolean) {
    await this.ports.authorizeCreator(actor);
    await this.store.transaction(tx => { const asset = tx.get('asset', id); if (!asset || asset.ownerId !== actor.ownerId) throw new CommerceError('asset_not_found', 404);
      asset.state = available ? 'available' : 'unavailable'; tx.put('asset', asset);
      for (const pack of tx.list('package').filter(p => tx.get('offer', p.offerVersionId)?.files.includes(id))) {
        const offer = tx.get('offer', pack.offerVersionId)!, packageAsset = tx.get('asset', pack.assetId);
        const ready = offer.files.every(file => tx.get('asset', file)?.state === 'available');
        const built=!!packageAsset?.objectId;
        pack.state = ready ? built ? 'ready' : 'preparing' : 'unavailable'; tx.put('package', pack);
        if (packageAsset) { packageAsset.state = ready ? built ? 'available' : 'preparing' : 'unavailable'; tx.put('asset', packageAsset); }
      }
      this.audit(tx, asset, actor.subjectId, 'asset.availability', id); });
  }
  async publishOffer(actor: CreatorActor, input: { environment: Environment; offerId?: string; slug: string; title: string; description?: string;
    requestId?:string; amountMinor: number; currency: string; benefits: Benefit[]; files: string[]; previews?: string[]; terms: string; supportEmail: string; durationSeconds?: number;
    external?: { url: string; mappingId: string } }) {
    await this.ports.authorizeCreator(actor); const scope = this.scope(actor.ownerId, input.environment);
    await this.ports.assertEligible(scope); const connection = await this.ports.connection(actor.ownerId, input.environment);
    currencyExponent(input.currency);
    if (typeof input.slug !== 'string' || !Array.isArray(input.benefits) || !Array.isArray(input.files) || (input.previews !== undefined && !Array.isArray(input.previews))) throw new CommerceError('invalid_offer');
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(input.slug)
      || !input.title || input.title.length > 300 || !input.terms || input.terms.length > 10000 || !input.benefits.length || input.benefits.length > 2000
      || input.files.length > 1000 || (input.durationSeconds !== undefined && (!Number.isSafeInteger(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > 315360000)))
      throw new CommerceError('invalid_offer');
    const supportEmail = email(input.supportEmail);
    await this.ports.assertOfferEligible?.(scope,input);
    if (input.external) { const url = new URL(input.external.url); if (url.protocol !== 'https:' || !['paypal.com', 'www.paypal.com', 'paypal.me', 'www.paypal.me'].includes(url.hostname)
      || url.username || url.password || !input.external.mappingId || input.external.mappingId.length > 200) throw new CommerceError('invalid_external_link'); }
    return this.store.transaction(tx => {
      if(input.requestId&&!/^[A-Za-z0-9_-]{8,200}$/.test(input.requestId))throw new CommerceError('invalid_idempotency_key');
      const commandHash=hash(JSON.stringify(input)),requestId=input.requestId?key('offer-command',scope,input.requestId):undefined,prior=requestId?tx.get('offer',requestId):undefined;
      if(prior){if(prior.commandHash!==commandHash)throw new CommerceError('idempotency_conflict',409);return prior;}
      const versions = tx.list('offer').filter(o => o.offerId === input.offerId && same(o, scope));
      if (input.offerId && !versions.length) throw new CommerceError('offer_not_found', 404);
      const slugOwner = tx.list('offer').find(o => o.slug === input.slug && same(o, scope) && o.offerId !== input.offerId);
      if (slugOwner) throw new CommerceError('offer_slug_conflict', 409);
      const files = [...new Set(input.files)], previews = [...new Set(input.previews ?? [])];
      for (const id of [...files, ...previews]) {
        const asset = tx.get('asset', id); if (!asset || !same(asset, scope) || asset.state !== 'available' || (previews.includes(id) && !asset.publicPreview) || (files.includes(id) && asset.publicPreview))
          throw new CommerceError('invalid_offer_asset');
      }
      for (const benefit of input.benefits) {
        if (!['gallery','download','package','discord_role'].includes(benefit.type) || !benefit.resourceId || benefit.resourceId.length > 200) throw new CommerceError('invalid_benefit');
        if (benefit.type === 'download' && !files.includes(benefit.resourceId)) throw new CommerceError('download_not_in_snapshot');
        if (benefit.type === 'gallery' && !files.length) throw new CommerceError('empty_gallery');
        if (benefit.type === 'discord_role') {
          const guild = tx.list('guild').find(g => same(g, scope) && g.guildId === benefit.guildId && g.roleIds.includes(benefit.roleId));
          if (!guild) throw new CommerceError('discord_role_not_configured');
        }
      }
      const offer: Offer = { ...this.base(scope,requestId), ...(requestId?{commandHash}:{}), offerId: input.offerId ?? randomUUID(), version: versions.reduce((max, v) => Math.max(max, v.version), 0) + 1,
        slug: input.slug, title: input.title, description: input.description ?? '', supportEmail, connectionId: connection.id, merchantId: connection.merchantId ?? '',
        currency: input.currency, amountMinor: input.amountMinor, benefits: structuredClone(input.benefits), files, previews, terms: input.terms,
        published: true, ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }), ...(input.external ? { external: structuredClone(input.external) } : {}) };
      for(const previous of versions){previous.published=false;tx.put('offer',previous);}
      tx.insert('offer', offer, [key('offer-version', scope, offer.offerId, offer.version)]);
      this.audit(tx, scope, actor.subjectId, 'offer.publish', offer.id);
      if (offer.benefits.some(b => b.type === 'package')) {
        const id = key('package', offer.id); tx.insert('package', { ...this.base(scope, id), offerVersionId: offer.id, assetId: id, state: 'preparing' });
        tx.insert('asset', { ...this.base(scope, id), label: offer.title + '.zip', contentType: 'application/zip', byteLength: 0, checksum: '0'.repeat(64), objectId: '', publicPreview: false, state: 'preparing' });
        this.queue(tx, scope, 'package', id, id);
      }
      return offer;
    });
  }
  async storefront(ownerId: string, environment: Environment) {
    const scope = this.scope(ownerId, environment); await this.ports.assertEligible(scope);
    const connection=await this.ports.connection(ownerId,environment).catch(()=>undefined);
    const offers=await this.store.transaction(tx => {
      const latest = new Map<string, Offer>();
      for (const offer of tx.list('offer').filter(o => same(o, scope))) if (!latest.has(offer.offerId) || latest.get(offer.offerId)!.version < offer.version) latest.set(offer.offerId, offer);
      return [...latest.values()].filter(o => o.published).map(({ merchantId, connectionId, ...o }) => ({ ...o,availableForCheckout:connection?.id===connectionId, includedFiles:o.files.map(id=>({id,label:tx.get('asset',id)?.label??'Unavailable item'})), external: o.external ? { ...o.external, automatic: !!o.external.validatedAt&&connection?.id===connectionId } : undefined }));
    });
    const eligible:typeof offers=[];for(const offer of offers){try{await this.ports.assertOfferEligible?.(scope,offer);eligible.push(offer);}catch{/* Policy-held offers are unavailable in public discovery. */}}return eligible;
  }
  async setOfferPublished(actor: CreatorActor, offerId: string, published: boolean) {
    await this.ports.authorizeCreator(actor);
    await this.store.transaction(tx => { const offer = tx.get('offer', offerId); if (!offer || offer.ownerId !== actor.ownerId) throw new CommerceError('offer_not_found', 404);
      if(published&&tx.list('offer').some(o=>o.offerId===offer.offerId&&same(o,offer)&&o.version>offer.version))throw new CommerceError('offer_version_superseded',409);
      offer.published = published; tx.put('offer', offer); this.audit(tx, offer, actor.subjectId, 'offer.visibility', offerId); });
  }
  async checkout(subjectId: string, offerVersionId: string, idempotencyKey: string) {
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(idempotencyKey)) throw new CommerceError('invalid_idempotency_key');
    const prior=await this.store.transaction(tx=>{const customer=this.customer(tx,subjectId),order=tx.get('checkout',key('checkout',customer.id,idempotencyKey));if(order&&order.offerVersionId!==offerVersionId)throw new CommerceError('idempotency_conflict',409);return order;});
    if(prior)return prior;
    const offer = await this.store.transaction(tx => tx.get('offer', offerVersionId));
    if (!offer?.published) throw new CommerceError('offer_not_found', 404);
    return this.ports.withConnectionLock(offer, async () => {
    await this.ports.assertOfferEligible?.(offer,offer);
    await this.ports.assertEligible(offer); const connection = await this.ports.connection(offer.ownerId, offer.environment);
    if (connection.id !== offer.connectionId) throw new CommerceError('offer_connection_requires_republish', 409);
    await this.rateLimit(subjectId, 'checkout', 30, 3600);
    return this.store.transaction(tx => {
      const customer = this.customer(tx, subjectId);
      if (!customer.verifiedEmails.length) throw new CommerceError('verified_recovery_email_required', 403);
      const id = key('checkout', customer.id, idempotencyKey), prior = tx.get('checkout', id);
      if (prior) { if (prior.offerVersionId !== offerVersionId) throw new CommerceError('idempotency_conflict', 409); return prior; }
      const current = tx.get('offer', offer.id); if (!current?.published) throw new CommerceError('offer_unavailable', 409);
      const order: Checkout = { ...this.base(offer, id), customerId: customer.id, offerVersionId: offer.id, connectionId: connection.id,
        merchantId: connection.merchantId ?? offer.merchantId, currency: offer.currency, amountMinor: offer.amountMinor, reference: randomUUID(), idempotencyKey,
        captureRequestId: randomUUID(), state: 'creating' };
      tx.insert('checkout', order, [key('checkout-idempotency', customer.id, idempotencyKey), key('order-reference', order.reference)]);
      this.queue(tx, order, 'create_order', order.id, order.id); return order;
    });
    });
  }
  async order(subjectId: string, id: string) {
    return this.store.transaction(tx => { const c = this.customer(tx, subjectId), order = tx.get('checkout', id);
      if (!order || order.customerId !== c.id) throw new CommerceError('checkout_not_found', 404);
      return { order, payments: tx.list('payment').filter(p => p.checkoutId === id), purchases: tx.list('purchase').filter(p => p.customerId === c.id && tx.get('payment', p.paymentId)?.checkoutId === id) }; });
  }
  async capture(subjectId: string, id: string) {
    return this.store.transaction(tx => { const c = this.customer(tx, subjectId), order = tx.get('checkout', id);
      if (!order || order.customerId !== c.id) throw new CommerceError('checkout_not_found', 404);
      if (order.state === 'pending') this.queue(tx, order, 'capture', order.id, order.id);
      return { state: order.state }; });
  }
  private applyEvidence(tx: CommerceTransaction, scope: Scope, connectionId: string, evidence: PaymentEvidence, notificationEventId?: string): { payment: Payment; valid: boolean } {
    if (typeof evidence.captureId !== 'string' || !evidence.captureId || typeof evidence.merchantId !== 'string' || !evidence.merchantId || !evidence.currency || !Number.isSafeInteger(evidence.paidMinor) || evidence.paidMinor <= 0
      || !Number.isSafeInteger(evidence.refundedMinor) || evidence.refundedMinor < 0 || !Number.isFinite(Date.parse(evidence.updatedAt))) throw new CommerceError('invalid_provider_evidence');
    currencyExponent(evidence.currency);
    const id = key('payment', scope.deploymentId, scope.ownerId, scope.environment, evidence.merchantId, evidence.captureId);
    const prior = tx.get('payment', id), order = tx.list('checkout').find(o => same(o, scope) && o.providerOrderId === evidence.orderId && !!evidence.orderId);
    // Existing payments and provider product identifiers remain pinned to their
    // immutable offer versions, including delayed payments after withdrawal.
    const mapping=tx.get('externalMapping',key('external-mapping',scope.deploymentId,scope.ownerId,scope.environment,evidence.merchantId,evidence.mappingId));
    // Legacy proven mappings can be read only when unambiguous. Never choose a
    // version by current visibility, price or database ordering.
    const candidates = order ? [] : tx.list('offer').filter(o => same(o, scope) && o.external?.validatedAt && o.external.mappingId === evidence.mappingId && o.merchantId === evidence.merchantId);
    const offer = order ? tx.get('offer', order.offerVersionId) : prior?.offerVersionId ? tx.get('offer', prior.offerVersionId) : mapping ? tx.get('offer',mapping.offerVersionId) : candidates.length === 1 ? candidates[0] : undefined;
    let invalid = !offer ? candidates.length > 1 ? 'ambiguous_offer_mapping' : 'unknown_offer_mapping' : evidence.unsupported ? 'unsupported_payment_configuration' : undefined;
    if (order && (order.reference !== evidence.reference || order.merchantId !== evidence.merchantId)) invalid = 'order_or_merchant_mismatch';
    if (offer && (evidence.currency !== (order?.currency ?? offer.currency) || evidence.paidMinor !== (order?.amountMinor ?? offer.amountMinor))) invalid = 'amount_or_currency_mismatch';
    if (!order && !evidence.buyerEmail) invalid = 'verified_buyer_email_required';
    if (prior && (prior.paidMinor !== evidence.paidMinor || prior.currency !== evidence.currency || prior.checkoutId !== order?.id)) invalid = 'payment_identity_mismatch';
    const payment: Payment = prior ?? { ...this.base(scope, id), connectionId, merchantId: evidence.merchantId, providerPaymentId: evidence.captureId,
      providerOrderId: evidence.orderId, checkoutId: order?.id, offerVersionId: offer?.id, currency: evidence.currency, paidMinor: evidence.paidMinor,
      refundedMinor: 0, state: 'pending', providerUpdatedAt: evidence.updatedAt };
    for (const refund of evidence.refunds ?? []) {
      if (!refund.id || !Number.isSafeInteger(refund.amountMinor) || refund.amountMinor < 0) throw new CommerceError('invalid_refund_evidence');
      const refundId = key('refund', id, refund.id), old = tx.get('refund', refundId);
      // A delayed pending/failed notification cannot erase an observed completed refund.
      if (old?.state !== 'COMPLETED') tx.put('refund', { ...this.base(scope, refundId), paymentId: id, providerRefundId: refund.id, amountMinor: refund.amountMinor, state: refund.state });
    }
    const refundTotal = tx.list('refund').filter(r => r.paymentId === id && r.state === 'COMPLETED').reduce((n, r) => n + r.amountMinor, 0);
    payment.refundedMinor = Math.max(payment.refundedMinor, evidence.refundedMinor, refundTotal, evidence.status === 'refunded' ? payment.paidMinor : 0);
    if (payment.refundedMinor > payment.paidMinor) invalid = 'refund_total_exceeds_payment';
    const terminal = payment.state === 'refunded' || payment.state === 'reversed';
    if (!invalid) {
      payment.checkoutId = order?.id; payment.offerVersionId = offer!.id;
      if (evidence.status === 'reversed' || payment.state === 'reversed') payment.state = 'reversed';
      else if (payment.refundedMinor >= payment.paidMinor || payment.state === 'refunded') payment.state = 'refunded';
      else if (payment.refundedMinor > 0 || evidence.status === 'partially_refunded') payment.state = 'partially_refunded';
      else if (!terminal && Date.parse(evidence.updatedAt) >= Date.parse(payment.providerUpdatedAt)) payment.state = evidence.status;
      payment.reviewReason = payment.state === 'partially_refunded' ? 'partial_refund_access_remains_active' : undefined;
    } else { payment.reviewReason = invalid; if (!terminal) payment.state = 'needs_review'; }
    payment.updatedAt = this.now(); payment.providerUpdatedAt = new Date(Math.max(Date.parse(payment.providerUpdatedAt), Date.parse(evidence.updatedAt))).toISOString();
    if (evidence.dispute) payment.dispute = evidence.dispute;
    if (notificationEventId) payment.notificationEventId = notificationEventId;
    tx.put('payment', payment);
    if (order) { order.state = invalid ? 'needs_review' : ['completed','partially_refunded','refunded','reversed'].includes(payment.state) ? 'completed' : payment.state === 'failed' ? 'failed' : 'pending'; order.reviewReason = invalid; tx.put('checkout', order); }
    const purchaseId = key('purchase', id), existing = tx.get('purchase', purchaseId);
    if (!invalid && !existing && ['completed', 'partially_refunded'].includes(payment.state)) {
      const purchase = { ...this.base(scope, purchaseId), paymentId: id, offerVersionId: offer!.id, customerId: order?.customerId,
        buyerEmail: evidence.buyerEmail ? email(evidence.buyerEmail) : undefined, state: 'active' as const, claimedAt: order ? this.now() : undefined };
      tx.insert('purchase', purchase, [key('purchase-payment', id)]);
      for (const benefit of offer!.benefits) tx.insert('entitlement', { ...this.base(scope, key('grant', purchaseId, benefit)), customerId: purchase.customerId,
        purchaseId, source: 'payment', benefit: structuredClone(benefit), assetIds: benefit.type === 'gallery' ? [...offer!.files] : benefit.type === 'download' ? [benefit.resourceId] : benefit.type === 'package' ? [key('package', offer!.id)] : [], startsAt: purchase.createdAt,
        ...(offer!.durationSeconds ? { endsAt: new Date(Date.parse(purchase.createdAt) + offer!.durationSeconds * 1000).toISOString() } : {}), state: 'active' });
      if (!purchase.customerId) this.createClaim(tx, purchaseId);
      else this.queue(tx, scope, 'discord', purchase.customerId);
    }
    if (['refunded', 'reversed'].includes(payment.state)) {
      if (existing) { existing.state = 'revoked'; tx.put('purchase', existing); }
      for (const grant of tx.list('entitlement').filter(g => g.purchaseId === purchaseId)) { grant.state = 'revoked'; tx.put('entitlement', grant); }
      if (existing?.customerId) this.queue(tx, scope, 'discord', existing.customerId);
    }
    this.audit(tx, scope, 'provider', 'payment.reconcile', id, payment.reviewReason);
    return { payment, valid: !invalid };
  }
  async reconcile(scope: Scope, connectionId: string, evidence: PaymentEvidence[], notificationEventId?: string) {
    if (scope.deploymentId !== this.store.deploymentId) throw new CommerceError('foreign_deployment', 403);
    const results = await this.store.transaction(tx => {
      if (notificationEventId) { const event = tx.get('event', notificationEventId); if (!event || !same(event, scope) || event.connectionId !== connectionId) throw new CommerceError('verified_event_required'); }
      return evidence.map(item => this.applyEvidence(tx, scope, connectionId, item, notificationEventId));
    });
    for (const result of results) if (result.valid && ['completed','partially_refunded','refunded','reversed'].includes(result.payment.state))
      await this.ports.markVerified(scope, connectionId, result.payment.merchantId, this.now());
    return results.map(r => r.payment);
  }
  private createClaim(tx: CommerceTransaction, purchaseId: string) {
    const purchase = tx.get('purchase', purchaseId);
    if (!purchase?.buyerEmail || purchase.customerId || purchase.state !== 'active') return;
    for (const prior of tx.list('claim').filter(c => c.purchaseId === purchaseId && !c.consumedAt)) { prior.consumedAt = this.now(); tx.put('claim', prior); }
    const id = randomUUID(), claim: Claim = { ...this.base(purchase, id), purchaseId, email: purchase.buyerEmail,
      tokenHash: hash(this.token('claim', id)), expiresAt: new Date(Date.parse(this.now()) + 86400000).toISOString() };
    tx.insert('claim', claim); this.queue(tx, purchase, 'claim_email', id);
  }
  async redeemClaim(subjectId: string, id: string, token: string) {
    await this.rateLimit(subjectId, 'claim', 10, 3600);
    return this.store.transaction(tx => { const customer = this.customer(tx, subjectId), claim = tx.get('claim', id);
      if (!claim || claim.consumedAt || claim.expiresAt <= this.now() || !safeEqual(claim.tokenHash, hash(token))) throw new CommerceError('invalid_claim', 403);
      if (!customer.verifiedEmails.includes(claim.email)) throw new CommerceError('purchase_email_verification_required', 403);
      const purchase = tx.get('purchase', claim.purchaseId); if (!purchase || purchase.customerId || purchase.state !== 'active') throw new CommerceError('invalid_claim', 403);
      purchase.customerId = customer.id; purchase.claimedAt = this.now(); tx.put('purchase', purchase);
      purchase.buyerEmail = undefined; tx.put('purchase', purchase);
      claim.consumedAt = this.now(); tx.put('claim', claim);
      for (const grant of tx.list('entitlement').filter(g => g.purchaseId === purchase.id)) { grant.customerId = customer.id; tx.put('entitlement', grant); }
      this.queue(tx, purchase, 'discord', customer.id); this.audit(tx, purchase, subjectId, 'purchase.claim', purchase.id); return { purchaseId: purchase.id };
    });
  }
  async resendClaim(actor: CreatorActor, purchaseId: string) {
    await this.ports.authorizeCreator(actor); await this.rateLimit(purchaseId, 'claim_resend', 3, 3600);
    await this.store.transaction(tx => { const p = tx.get('purchase', purchaseId); if (!p || p.ownerId !== actor.ownerId) throw new CommerceError('purchase_not_found', 404);
      this.createClaim(tx, p.id); this.audit(tx, p, actor.subjectId, 'claim.resend', p.id); }); return { queued: true };
  }
  async recoverClaims(subjectId: string) {
    await this.rateLimit(subjectId, 'customer_claim_resend', 3, 3600);
    await this.store.transaction(tx => { const c = this.customer(tx, subjectId);
      for (const purchase of tx.list('purchase').filter(p => !p.customerId && p.buyerEmail && c.verifiedEmails.includes(p.buyerEmail) && p.state === 'active')) {
        this.createClaim(tx, purchase.id); this.audit(tx, purchase, subjectId, 'claim.customer_recovery', purchase.id);
      }
    }); return { queued: true };
  }
  async purchases(subjectId: string) {
    return this.store.transaction(tx => { const c = this.customer(tx, subjectId);
      return tx.list('purchase').filter(p => p.customerId === c.id).map(p => ({ id: p.id, ownerId: p.ownerId, environment: p.environment, state: p.state, createdAt: p.createdAt,
        offer: tx.get('offer', p.offerVersionId), payment: tx.get('payment', p.paymentId), entitlements: tx.list('entitlement').filter(g => g.purchaseId === p.id),
        packages: tx.list('package').filter(a => a.offerVersionId === p.offerVersionId), discordInvites:tx.list('guild').filter(g=>same(g,p)&&tx.list('entitlement').some(e=>e.purchaseId===p.id&&isActive(e,this.now())&&e.benefit.type==='discord_role'&&e.benefit.guildId===g.guildId)).map(g=>({guildId:g.guildId,inviteUrl:g.inviteUrl})), discordJobs:tx.list('job').filter(j=>j.kind==='discord'&&j.referenceId===c.id&&same(j,p)).map(j=>({state:j.state,lastError:j.lastError})), discord: tx.list('discordRole').filter(r => r.customerId === c.id && r.ownerId === p.ownerId && r.environment === p.environment) })); });
  }
  async retryCustomerDiscord(subjectId:string){await this.rateLimit(subjectId,'customer_discord_retry',10,3600);await this.store.transaction(tx=>{const c=this.customer(tx,subjectId),scopes=new Map<string,Scope>();for(const g of tx.list('entitlement').filter(g=>g.customerId===c.id))scopes.set(key(g.ownerId,g.environment),g);for(const s of scopes.values())this.queue(tx,s,'discord',c.id);});return {queued:true};}
  async myAccess(subjectId: string) {
    return this.store.transaction(tx => { const customer = this.customer(tx, subjectId), entitlements = tx.list('entitlement').filter(g => g.customerId === customer.id && isActive(g, this.now()));
      const ids = new Set(entitlements.flatMap(g => g.assetIds));
      return { entitlements, assets: tx.list('asset').filter(a => ids.has(a.id)).map(({ objectId, source, ...asset }) => asset) }; });
  }
  async creatorHistory(actor: CreatorActor) {
    await this.ports.authorizeCreator(actor);
    return this.store.transaction(tx => ({ payments: tx.list('payment').filter(p => p.ownerId === actor.ownerId), purchases: tx.list('purchase').filter(p => p.ownerId === actor.ownerId),
      jobs: tx.list('job').filter(p => p.ownerId === actor.ownerId).map(({ leaseId, ...j }) => j), audits: tx.list('audit').filter(p => p.ownerId === actor.ownerId),
      offers: tx.list('offer').filter(p => p.ownerId === actor.ownerId), assets: tx.list('asset').filter(p => p.ownerId === actor.ownerId),
      checkouts: tx.list('checkout').filter(p => p.ownerId === actor.ownerId),
      guilds: tx.list('guild').filter(p=>p.ownerId===actor.ownerId),
      discord: tx.list('discordRole').filter(p => p.ownerId === actor.ownerId) }));
  }
  async retry(actor: CreatorActor, kind: 'reconcile' | 'discord', id: string) {
    await this.ports.authorizeCreator(actor); await this.rateLimit(actor.subjectId, 'manual_retry', 30, 3600);
    await this.store.transaction(tx => {
      const record = kind === 'reconcile' ? tx.get('payment', id) ?? tx.get('checkout', id) : tx.get('purchase', id);
      if (!record || record.ownerId !== actor.ownerId) throw new CommerceError('record_not_found', 404);
      const reference = kind === 'discord' ? tx.get('purchase', id)?.customerId : id;
      if (!reference) throw new CommerceError('customer_not_claimed');
      this.queue(tx, record, kind, reference); this.audit(tx, record, actor.subjectId, kind + '.retry', id);
    });
  }
  async manualGrant(actor: CreatorActor, input: { customerId: string; environment: Environment; benefit: Benefit; reason: string; endsAt?: string }) {
    await this.ports.authorizeCreator(actor); const scope = this.scope(actor.ownerId, input.environment);
    if (!input.reason?.trim() || input.reason.length > 1000 || (input.endsAt && (!Number.isFinite(Date.parse(input.endsAt)) || Date.parse(input.endsAt) <= Date.parse(this.now())))) throw new CommerceError('grant_reason_or_duration_invalid');
    const endsAt=input.endsAt?new Date(input.endsAt).toISOString():undefined;
    return this.store.transaction(tx => { if (!tx.get('customer', input.customerId)) throw new CommerceError('customer_not_found', 404);
      if (!['gallery','download','package','discord_role'].includes(input.benefit.type)) throw new CommerceError('invalid_benefit');
      let assetIds: string[] = [];
      if (input.benefit.type === 'download') { const asset = tx.get('asset', input.benefit.resourceId); if (!asset || !same(asset, scope) || asset.publicPreview) throw new CommerceError('invalid_grant_resource'); assetIds = [asset.id]; }
      else if (input.benefit.type === 'gallery' || input.benefit.type === 'package') {
        const offer = tx.list('offer').filter(o => same(o, scope) && o.benefits.some(b => b.type === input.benefit.type && b.resourceId === input.benefit.resourceId)).sort((a,b) => b.version-a.version)[0];
        if (!offer) throw new CommerceError('invalid_grant_resource'); assetIds = input.benefit.type === 'gallery' ? [...offer.files] : [key('package', offer.id)];
      } else if (input.benefit.type === 'discord_role' && !tx.list('guild').some(g => same(g, scope) && input.benefit.type === 'discord_role' && g.guildId === input.benefit.guildId && g.roleIds.includes(input.benefit.roleId))) throw new CommerceError('invalid_grant_resource');
      const grant = { ...this.base(scope), customerId: input.customerId, source: 'manual' as const, benefit: structuredClone(input.benefit), assetIds, reason: input.reason,
        startsAt: this.now(), ...(endsAt ? { endsAt } : {}), state: 'active' as const };
      tx.insert('entitlement', grant); this.queue(tx, scope, 'discord', input.customerId); this.audit(tx, scope, actor.subjectId, 'entitlement.manual_grant', grant.id, input.reason); return grant; });
  }
  async revoke(actor: CreatorActor, grantId: string, reason: string) {
    await this.ports.authorizeCreator(actor); if (!reason?.trim()) throw new CommerceError('reason_required');
    await this.store.transaction(tx => { const grant = tx.get('entitlement', grantId); if (!grant || grant.ownerId !== actor.ownerId) throw new CommerceError('entitlement_not_found', 404);
      grant.state = 'revoked'; tx.put('entitlement', grant); this.audit(tx, grant, actor.subjectId, 'entitlement.revoke', grantId, reason);
      if (grant.customerId) this.queue(tx, grant, 'discord', grant.customerId); });
  }
  private canRead(tx: CommerceTransaction, customerId: string, asset: PrivateAsset): boolean {
    return tx.list('entitlement').some(g => g.customerId === customerId && same(g, asset) && isActive(g, this.now()) && g.assetIds.includes(asset.id));
  }
  async authorizeDownload(subjectId: string, assetId: string) {
    return this.store.transaction(tx => { const c = this.customer(tx, subjectId), asset = tx.get('asset', assetId);
      if (!asset || !this.canRead(tx, c.id, asset)) throw new CommerceError('access_denied', 403);
      if (asset.state !== 'available') throw new CommerceError(asset.state === 'preparing' ? 'preparing_download' : 'content_unavailable', 409);
      const expiresAt = new Date(Date.parse(this.now()) + 300000).toISOString(), payload = Buffer.from(JSON.stringify({ assetId, customerId: c.id, expiresAt, deploymentId: this.store.deploymentId })).toString('base64url');
      const signature = createHmac('sha256', this.ports.tokenKey).update('download:' + payload).digest('base64url');
      return { url: this.baseUrl + '/api/private-assets/' + assetId + '?token=' + payload + '.' + signature, expiresAt }; });
  }
  async download(assetId: string, token: string) {
    const [payload, signature, extra] = token.split('.'); if (!payload || !signature || extra || payload.length > 4000) throw new CommerceError('invalid_download', 403);
    if (!safeEqual(signature, createHmac('sha256', this.ports.tokenKey).update('download:' + payload).digest('base64url'))) throw new CommerceError('invalid_download', 403);
    let claims: any; try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw new CommerceError('invalid_download', 403); }
    if (claims.assetId !== assetId || claims.deploymentId !== this.store.deploymentId || !Number.isFinite(Date.parse(claims.expiresAt)) || claims.expiresAt <= this.now()) throw new CommerceError('invalid_download', 403);
    const asset = await this.store.transaction(tx => { const a = tx.get('asset', assetId); if (!a || !this.canRead(tx, claims.customerId, a)) throw new CommerceError('access_denied', 403); return a; });
    if (asset.state !== 'available') throw new CommerceError('content_unavailable', 409);
    const sources = await this.store.transaction(tx => { const pack = tx.list('package').find(p => p.assetId === assetId); return pack ? tx.get('offer', pack.offerVersionId)?.files.map(id => tx.get('asset', id)) : undefined; });
    if (sources) for (const source of sources) {
      if (!source || source.state !== 'available') throw new CommerceError('content_unavailable',409);
      // A cached archive must not bypass a source policy removal or deleted original.
      await this.ports.assets.read(source);
    }
    const bytes = await this.ports.assets.read(asset);
    if (bytes.length !== asset.byteLength || createHash('sha256').update(bytes).digest('hex') !== asset.checksum) throw new CommerceError('content_unavailable', 409);
    return { asset, bytes };
  }
  async preview(id: string) {
    const asset = await this.store.transaction(tx => tx.get('asset', id));
    if (!asset?.publicPreview || asset.state !== 'available') throw new CommerceError('preview_not_found', 404);
    return { asset, bytes: await this.ports.assets.read(asset) };
  }
  async beginDiscord(subjectId: string, creator?: CreatorActor, environment: Environment = 'live') {
    if (!this.ports.discord) throw new CommerceError('discord_unavailable', 503);
    if (creator) await this.ports.authorizeCreator(creator);
    return this.store.transaction(tx => { const c = this.customer(tx, subjectId), id = randomUUID(), token = this.token('oauth', id);
      tx.insert('oauth', { ...this.base(this.scope(creator?.ownerId ?? subjectId, environment), id), customerId: c.id,
        tokenHash: hash(token), expiresAt: new Date(Date.parse(this.now()) + 600000).toISOString(), ...(creator ? { creatorSubjectId: creator.subjectId } : {}) });
      return { authorizationUrl: this.ports.discord!.authorizationUrl(id + '.' + token, !!creator), installUrl: this.ports.discord!.installUrl() }; });
  }
  async completeDiscord(subjectId: string, state: string, code: string, guild?: { guildId: string; roleIds: string[]; inviteUrl: string }) {
    if (!this.ports.discord) throw new CommerceError('discord_unavailable', 503);
    const [id, token, extra] = state.split('.'); if (!id || !token || extra) throw new CommerceError('invalid_oauth_state', 403);
    const consumed = await this.store.transaction(tx => { const c = this.customer(tx, subjectId), s = tx.get('oauth', id);
      if (!s || s.customerId !== c.id || s.consumedAt || s.expiresAt <= this.now() || !safeEqual(s.tokenHash, hash(token))) throw new CommerceError('invalid_oauth_state', 403);
      s.consumedAt = this.now(); tx.put('oauth', s); return s; });
    const identity = await this.ports.discord.exchange(code);
    if (guild) {
      const creatorSubjectId = (consumed as typeof consumed & { creatorSubjectId?: string }).creatorSubjectId;
      if (creatorSubjectId !== subjectId || !/^\d{1,22}$/.test(guild.guildId) || !Array.isArray(guild.roleIds) || !guild.roleIds.length || guild.roleIds.some(id => !/^\d{1,22}$/.test(id))) throw new CommerceError('invalid_discord_guild');
      const actor = { subjectId, ownerId: consumed.ownerId }; await this.ports.authorizeCreator(actor);
      const invite = new URL(guild.inviteUrl); if (invite.protocol !== 'https:' || invite.username || invite.password || invite.search || invite.hash || !((invite.hostname==='discord.gg'&&/^\/[A-Za-z0-9_-]+\/?$/.test(invite.pathname))||(invite.hostname==='discord.com'&&/^\/invite\/[A-Za-z0-9_-]+\/?$/.test(invite.pathname)))) throw new CommerceError('invalid_discord_invite');
      await this.ports.discord.validateGuild(identity.accessToken, guild.guildId, guild.roleIds);
      await this.ports.discord.validateInvite?.(guild.guildId,guild.inviteUrl);
      await this.store.transaction(tx => {
        if (tx.list('guild').some(g => g.guildId === guild.guildId && g.environment !== consumed.environment)) throw new CommerceError('discord_environment_conflict', 409);
        const id = key('guild', consumed.ownerId, consumed.environment, guild.guildId);
        tx.put('guild', { ...this.base(consumed, id), guildId: guild.guildId, roleIds: guild.roleIds, inviteUrl: guild.inviteUrl });
        this.audit(tx, consumed, subjectId, 'discord.configure', guild.guildId);
      }); return { configured: true };
    }
    if (consumed.creatorSubjectId) {
      await this.ports.authorizeCreator({ subjectId, ownerId: consumed.ownerId });
      if (!this.ports.discordTokens || !this.ports.discord.guilds) throw new CommerceError('creator_guild_configuration_required');
      const guilds = await this.ports.discord.guilds(identity.accessToken), credentialReference = await this.ports.discordTokens.write(consumed, identity.accessToken), sessionId = randomUUID();
      try { await this.store.transaction(tx => tx.insert('discordSetup', { ...this.base(consumed,sessionId), customerId: consumed.customerId, subjectId, credentialReference,
        expiresAt: new Date(Date.parse(this.now()) + 600000).toISOString() })); }
      catch (error) { await this.ports.discordTokens.revoke(credentialReference).catch(()=>{}); throw error; }
      return { creatorSessionId: sessionId, guilds,ownerId:consumed.ownerId };
    }
    await this.store.transaction(tx => { const c = this.customer(tx, subjectId); c.discordUserId = identity.userId; tx.put('customer', c);
      const scopes = new Map<string, Scope>(); for (const g of tx.list('entitlement').filter(g => g.customerId === c.id)) scopes.set(key(g.ownerId, g.environment), g);
      for (const s of scopes.values()) this.queue(tx, s, 'discord', c.id); }); return { connected: true };
  }
  async discordFlow(subjectId: string, state: string) {
    const [id, token, extra] = state.split('.'); if (!id || !token || extra) throw new CommerceError('invalid_oauth_state',403);
    return this.store.transaction(tx => { const customer=this.customer(tx,subjectId), s=tx.get('oauth',id);
      if(!s || s.customerId!==customer.id || s.consumedAt || s.expiresAt<=this.now() || !safeEqual(s.tokenHash,hash(token)))throw new CommerceError('invalid_oauth_state',403);
      return { creator:!!s.creatorSubjectId, environment:s.environment,ownerId:s.ownerId }; });
  }
  async discordSetupRoles(actor: CreatorActor, sessionId: string, guildId: string) {
    await this.ports.authorizeCreator(actor);
    const setup = await this.store.transaction(tx=>tx.get('discordSetup',sessionId));
    if(!setup || setup.subjectId!==actor.subjectId || setup.ownerId!==actor.ownerId || setup.expiresAt<=this.now() || !this.ports.discordTokens || !this.ports.discord?.roles)throw new CommerceError('discord_setup_expired',403);
    const token = await this.ports.discordTokens.read(setup.credentialReference); if(!token)throw new CommerceError('discord_setup_expired',403);
    await this.ports.discord.validateGuild(token,guildId,[]); return this.ports.discord.roles(guildId);
  }
  async configureDiscordSetup(actor: CreatorActor, sessionId: string, guild: {guildId:string;roleIds:string[];inviteUrl:string}) {
    await this.ports.authorizeCreator(actor);
    const setup=await this.store.transaction(tx=>tx.get('discordSetup',sessionId));
    if(!setup || setup.ownerId!==actor.ownerId || setup.subjectId!==actor.subjectId || setup.expiresAt<=this.now() || !this.ports.discordTokens || !this.ports.discord)throw new CommerceError('discord_setup_expired',403);
    if(!Array.isArray(guild.roleIds)||!guild.roleIds.length)throw new CommerceError('discord_roles_required');
    const invite=new URL(guild.inviteUrl);if(invite.protocol!=='https:'||invite.username||invite.password||invite.search||invite.hash||!((invite.hostname==='discord.gg'&&/^\/[A-Za-z0-9_-]+\/?$/.test(invite.pathname))||(invite.hostname==='discord.com'&&/^\/invite\/[A-Za-z0-9_-]+\/?$/.test(invite.pathname))))throw new CommerceError('invalid_discord_invite');
    const token=await this.ports.discordTokens.read(setup.credentialReference);if(!token)throw new CommerceError('discord_setup_expired',403);
    await this.ports.discord.validateGuild(token,guild.guildId,guild.roleIds);
    await this.ports.discord.validateInvite?.(guild.guildId,guild.inviteUrl);
    const roleLabels=Object.fromEntries((await this.ports.discord.roles?.(guild.guildId)??[]).filter(r=>guild.roleIds.includes(r.id)).map(r=>[r.id,r.name]));
    await this.store.transaction(tx=>{
      if(tx.list('guild').some(g=>g.guildId===guild.guildId&&g.environment!==setup.environment))throw new CommerceError('discord_environment_conflict',409);
      const id=key('guild',setup.ownerId,setup.environment,guild.guildId);tx.put('guild',{...this.base(setup,id),guildId:guild.guildId,roleIds:guild.roleIds,roleLabels,inviteUrl:guild.inviteUrl});
      this.audit(tx,setup,actor.subjectId,'discord.configure',guild.guildId);
    });
    await this.ports.discordTokens.revoke(setup.credentialReference);
    await this.store.transaction(tx=>tx.remove('discordSetup',sessionId));return {configured:true};
  }
  async validateExternalMapping(actor: CreatorActor, offerId: string, paymentId: string) {
    await this.ports.authorizeCreator(actor);
    const result = await this.store.transaction(tx => ({ offer: tx.get('offer', offerId), payment: tx.get('payment', paymentId) }));
    if (!result.offer?.external || result.offer.ownerId !== actor.ownerId || !result.payment || !same(result.offer, result.payment)) throw new CommerceError('mapping_evidence_not_found', 404);
    if (!result.payment.notificationEventId) throw new CommerceError('real_notification_evidence_required', 409);
    const evidence = await this.ports.provider.reconcile(result.offer, result.payment.connectionId, { captureId: result.payment.providerPaymentId });
    const proof = evidence.find(e => e.captureId === result.payment!.providerPaymentId && e.mappingId === result.offer!.external!.mappingId
      && e.buyerEmail && !e.unsupported && e.currency === result.offer!.currency && e.paidMinor === result.offer!.amountMinor && e.status === 'completed');
    if (!proof) throw new CommerceError('external_mapping_not_proven', 409);
    await this.store.transaction(tx => { const o = tx.get('offer', offerId)!;
      const mappingId=key('external-mapping',o.deploymentId,o.ownerId,o.environment,proof.merchantId,o.external!.mappingId),existingMapping=tx.get('externalMapping',mappingId);
      if (!o.published || existingMapping&&existingMapping.offerVersionId!==o.id || tx.list('offer').some(other => other.id !== o.id && same(other,o) && other.external?.validatedAt && other.external.mappingId === o.external!.mappingId && other.merchantId === proof.merchantId)) throw new CommerceError('external_mapping_conflict',409);
      if(!existingMapping)tx.insert('externalMapping',{...this.base(o,mappingId),merchantId:proof.merchantId,mappingId:o.external!.mappingId,offerVersionId:o.id,evidenceId:paymentId},[mappingId]);
      o.merchantId = proof.merchantId; o.external!.validatedAt = this.now(); o.external!.evidenceId = paymentId; tx.put('offer', o);
      this.audit(tx, o, actor.subjectId, 'external_mapping.validate', o.id); this.queue(tx, o, 'reconcile', paymentId); }); return { validated: true };
  }
  /** Durable periodic schedule; call from each worker tick. Unique windows avoid duplicate schedules. */
  async schedule() {
    if(this.ports.discordTokens)for(const setup of await this.store.transaction(tx=>tx.list('discordSetup').filter(s=>s.expiresAt<=this.now()))){
      try{await this.ports.discordTokens.revoke(setup.credentialReference);await this.store.transaction(tx=>tx.remove('discordSetup',setup.id));}catch{/* Keep the encrypted reference for the next cleanup attempt. */}
    }
    await this.store.transaction(tx => {
      const at = Date.parse(this.now()), quarter = Math.floor(at / 900000), day = Math.floor(at / 86400000);
      const batch=this.ports.reconciliation?.batchSize??100, recentDays=this.ports.reconciliation?.recentPaymentDays??30;let scheduled=0;
      for (const order of tx.list('checkout').filter(o => ['creating','pending'].includes(o.state))) {
        if(scheduled>=batch)break;
        if (order.state === 'creating') scheduled+=Number(this.queue(tx, order, 'create_order', order.id, order.id));
        else scheduled+=Number(this.queue(tx, order, 'reconcile', order.id, key('pending-order', order.id, quarter)));
      }
      for (const p of tx.list('payment').filter(p => ['completed','partially_refunded'].includes(p.state) && Date.parse(p.createdAt) > at - recentDays * 86400000)){
        if(scheduled>=batch)break;scheduled+=Number(this.queue(tx, p, 'reconcile', p.id, key('recent', p.id, day)));
      }
      const stalled=new Map<string,Scope>();for(const job of tx.list('job').filter(j=>j.state!=='done'&&Date.parse(j.createdAt)<at-900000))stalled.set(key(job.ownerId,job.environment),job);
      for(const scope of stalled.values())if(this.rate(tx,key(scope.ownerId,scope.environment),'backlog_alert',1,3600)){this.audit(tx,scope,'worker','operations.reconciliation_backlog',scope.ownerId);this.queue(tx,scope,'creator_notice',scope.ownerId,key('backlog',scope.ownerId,day));}
      // Periodic convergence repairs interrupted/stale remote side effects as well
      // as roles removed outside the application.
      const roleCustomers = new Map<string, {scope: Scope; customerId: string}>();
      for (const role of tx.list('discordRole')) roleCustomers.set(key(role.ownerId,role.environment,role.customerId),{scope:role,customerId:role.customerId});
      for (const grant of tx.list('entitlement').filter(g=>g.benefit.type==='discord_role'&&g.customerId&&isActive(g,this.now()))) roleCustomers.set(key(grant.ownerId,grant.environment,grant.customerId),{scope:grant,customerId:grant.customerId!});
      for (const {scope,customerId} of roleCustomers.values()) this.queue(tx,scope,'discord',customerId,key('discord-converge',scope.ownerId,scope.environment,customerId,quarter));
      // Expiry affects role state even when no payment event arrives.
      for (const grant of tx.list('entitlement').filter(g => g.benefit.type === 'discord_role' && g.endsAt && g.endsAt <= this.now() && g.state === 'active')) {
        grant.state = 'revoked'; tx.put('entitlement', grant); if (grant.customerId) this.queue(tx, grant, 'discord', grant.customerId);
      }
      for (const e of tx.list('event').filter(e => e.payload && e.payloadExpiresAt <= this.now())) { e.payload = undefined; tx.put('event', e); }
      for (const a of tx.list('audit').filter(a => Date.parse(a.createdAt) < at - 365 * 86400000)) tx.remove('audit', a.id);
      for (const r of tx.list('rate').filter(r => Date.parse(r.windowAt) < at - 86400000)) tx.remove('rate', r.id);
      for (const s of tx.list('session').filter(s => s.expiresAt <= this.now())) tx.remove('session', s.id);
      for (const login of tx.list('login').filter(s => s.expiresAt <= this.now())) tx.remove('login', login.id);
      for (const proof of tx.list('emailProof').filter(s => s.consumedAt || s.expiresAt <= this.now())) tx.remove('emailProof', proof.id);
      for (const claim of tx.list('claim').filter(s => s.consumedAt || s.expiresAt <= this.now())) tx.remove('claim', claim.id);
      for (const oauth of tx.list('oauth').filter(s => s.consumedAt || s.expiresAt <= this.now())) tx.remove('oauth', oauth.id);
    });
  }
  async runNextJob(workerId: string): Promise<DeliveryJob | undefined> {
    const job = await this.store.transaction(tx => {
      const at = this.now(), next = tx.list('job').filter(j => ((j.state === 'pending' || j.state === 'failed') && j.dueAt <= at) || (j.state === 'running' && j.leaseUntil! <= at))
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
      if (!next) return undefined;
      next.state = 'running'; next.leaseId = workerId + ':' + randomUUID(); next.leaseUntil = new Date(Date.parse(at) + 300000).toISOString(); next.attempts++;
      if(next.kind==='event'){const event=tx.get('event',next.referenceId);if(event){event.attempts=next.attempts;tx.put('event',event);}}
      tx.put('job', next); return next;
    });
    if (!job) return undefined;
    try { await this.processJob(job); }
    catch (error) {
      const raw = error as { code?: string; retryAfterSeconds?: number };
      const code = error instanceof CommerceError ? error.code : typeof raw.code === 'string' && /^[a-z_]{1,80}$/.test(raw.code) ? raw.code : 'delivery_failed';
      await this.store.transaction(tx => { const current = tx.get('job', job.id); if (!current || current.leaseId !== job.leaseId) return;
        const awaitingApproval=code==='provider_order_not_approved';
        current.state = awaitingApproval?'pending':'failed'; current.lastError = awaitingApproval?undefined:code; current.leaseUntil = undefined;
        if(job.kind==='event'){const event=tx.get('event',job.referenceId);if(event){event.lastError=code;tx.put('event',event);}}
        const wait = Math.max(0, Math.min(86400, raw.retryAfterSeconds ?? 0), Math.min(900, 2 ** Math.min(current.attempts, 10)));
        current.dueAt = new Date(Date.parse(this.now()) + wait * 1000).toISOString(); tx.put('job', current);
        if (['discord','event','capture','reconcile','package'].includes(job.kind) && !['discord_membership_required','provider_order_not_approved'].includes(code)) this.queue(tx, job, 'creator_notice', job.id, key('delivery-alert',job.ownerId,Math.floor(Date.parse(this.now())/86400000)));
        if(job.kind==='package'){const pack=tx.get('package',job.referenceId);if(pack&&pack.state!=='ready'){pack.state='unavailable';tx.put('package',pack);const asset=tx.get('asset',pack.assetId);if(asset){asset.state='unavailable';tx.put('asset',asset);}}}
      }); return { ...job, state:code==='provider_order_not_approved'?'pending':'failed', lastError:code==='provider_order_not_approved'?undefined:code };
    }
    await this.store.transaction(tx => { const current = tx.get('job', job.id); if (current && current.leaseId === job.leaseId) { current.state = 'done'; current.leaseUntil = undefined; current.lastError = undefined; tx.put('job', current); } });
    return { ...job, state: 'done' };
  }
  private async processJob(job: DeliveryJob) {
    if (job.kind === 'create_order') {
      const snapshot = await this.store.transaction(tx => { const order = tx.get('checkout', job.referenceId); return order ? { order, offer: tx.get('offer', order.offerVersionId) } : undefined; });
      if (!snapshot?.offer || snapshot.order.providerOrderId || snapshot.order.state !== 'creating') return;
      if (job.attempts > 1 && Date.parse(this.now()) - Date.parse(snapshot.order.createdAt) > 5 * 3600000) {
        await this.store.transaction(tx => { const order = tx.get('checkout', job.referenceId)!; order.state = 'needs_review'; order.reviewReason = 'provider_create_idempotency_window_elapsed'; tx.put('checkout', order); this.audit(tx, order, 'worker', 'checkout.needs_review', order.id, order.reviewReason); }); return;
      }
      const created = await this.ports.provider.createOrder(snapshot.order, snapshot.offer);
      if (!created.orderId || !created.merchantId || (snapshot.order.merchantId && created.merchantId !== snapshot.order.merchantId)) throw new CommerceError('order_merchant_mismatch');
      const approval = new URL(created.approvalUrl);
      if (approval.protocol !== 'https:' || approval.username || approval.password || !(job.environment === 'sandbox' ? ['www.sandbox.paypal.com','sandbox.paypal.com'] : ['www.paypal.com','paypal.com']).includes(approval.hostname)) throw new CommerceError('invalid_approval_url');
      await this.ports.bindMerchant?.(snapshot.order, snapshot.order.connectionId, created.merchantId);
      await this.store.transaction(tx => { const order = tx.get('checkout', job.referenceId)!;
        if (order.providerOrderId && order.providerOrderId !== created.orderId) throw new CommerceError('provider_order_conflict');
        order.providerOrderId = created.orderId; order.approvalUrl = created.approvalUrl; order.merchantId = created.merchantId; order.state = 'pending'; tx.put('checkout', order); }); return;
    }
    if (job.kind === 'capture') {
      const order = await this.store.transaction(tx => tx.get('checkout', job.referenceId)); if (!order?.providerOrderId || order.state === 'completed' || order.state === 'failed') return;
      await this.ports.assertEligible(order);const offer=await this.store.transaction(tx=>tx.get('offer',order.offerVersionId));if(!offer)throw new CommerceError('offer_not_found',404);
      await this.ports.assertOfferEligible?.(order,offer);
      await this.ports.provider.capture(order);
      await this.reconcile(order, order.connectionId, await this.ports.provider.reconcile(order, order.connectionId, { orderId: order.providerOrderId })); return;
    }
    if (job.kind === 'event') {
      const event = await this.store.transaction(tx => tx.get('event', job.referenceId)); if (!event || event.state === 'processed') return;
      if (!event.payload) throw new CommerceError('event_payload_expired_recheck_required');
      const data = JSON.parse(event.payload);
      if (event.eventType === 'CHECKOUT.ORDER.APPROVED' || event.eventType === 'CHECKOUT.PAYMENT-APPROVAL.REVERSED') {
        await this.store.transaction(tx => { const order = tx.list('checkout').find(o => same(o, event) && o.providerOrderId === data.resource?.id);
          if (order && order.state !== 'completed') {
            if (event.eventType === 'CHECKOUT.ORDER.APPROVED') this.queue(tx, order, 'capture', order.id, order.id);
            else { order.state = 'failed'; tx.put('checkout', order); }
          }
          event.state = 'processed'; tx.put('event', event);
        }); return;
      }
      const evidence = await this.ports.provider.reconcile(event, event.connectionId, { eventId: event.eventId, eventType: event.eventType, payload: event.payload });
      const results = await this.reconcile(event, event.connectionId, evidence, event.id);
      await this.store.transaction(tx => { event.state = results.some(p => p.state === 'needs_review') ? 'needs_review' : 'processed';event.lastError=undefined;tx.put('event', event); }); return;
    }
    if (job.kind === 'reconcile') {
      const reference = await this.store.transaction(tx => ({ payment: tx.get('payment', job.referenceId), order: tx.get('checkout', job.referenceId) }));
      const c = reference.payment ?? reference.order; if (!c) return;
      const evidence = await this.ports.provider.reconcile(c, c.connectionId, reference.payment ? { captureId: reference.payment.providerPaymentId } : { orderId: reference.order!.providerOrderId });
      await this.reconcile(c, c.connectionId, evidence);
      if (!evidence.length && reference.order?.providerOrderId && this.ports.provider.orderStatus) {
        const status = await this.ports.provider.orderStatus(reference.order);
        await this.store.transaction(tx => { const order = tx.get('checkout', reference.order!.id)!; if (order.state === 'completed') return;
          if (status === 'failed') { order.state = 'failed'; tx.put('checkout', order); }
          if (status === 'approved') this.queue(tx, order, 'capture', order.id, order.id);
        });
      }
      return;
    }
    if (job.kind === 'claim_email' || job.kind === 'verify_email' || job.kind === 'login_email') {
      const proof = await this.store.transaction(tx => job.kind === 'claim_email' ? tx.get('claim', job.referenceId) : job.kind === 'login_email' ? tx.get('login', job.referenceId) : tx.get('emailProof', job.referenceId));
      if (!proof || proof.consumedAt || proof.expiresAt <= this.now()) return;
      const purpose = job.kind === 'claim_email' ? 'claim' : job.kind === 'login_email' ? 'login' : 'email', route = purpose === 'claim' ? 'claim' : purpose === 'login' ? 'sign-in' : 'verify-email';
      await this.ports.mail.send({ to: proof.email, subject: purpose === 'claim' ? 'Claim your purchase' : purpose === 'login' ? 'Sign in to your purchases' : 'Verify your recovery email',
        text: this.baseUrl + '/commerce/' + route + '?id=' + proof.id + '&token=' + this.token(purpose, proof.id), idempotencyKey: job.id }); return;
    }
    if (job.kind === 'package') { await this.preparePackage(job); return; }
    if (job.kind === 'discord') { await this.deliverDiscord(job); return; }
    if (job.kind === 'creator_notice') {
      const contact = await this.store.transaction(tx => tx.list('offer').filter(o => same(o, job)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0]?.supportEmail);
      if (contact) await this.ports.mail.send({ to: contact, subject: 'Creator delivery needs attention', text: 'A delivery could not be completed. Review its status and retry at ' + this.baseUrl + '/commerce/creator', idempotencyKey: job.id });
      return;
    }
  }
  private async preparePackage(job: DeliveryJob) {
    if (this.ports.withStorageLock) return this.ports.withStorageLock(job, () => this.buildPackage(job));
    return this.buildPackage(job);
  }
  private async buildPackage(job: DeliveryJob) {
    const snapshot = await this.store.transaction(tx => { const pack = tx.get('package', job.referenceId), offer = pack ? tx.get('offer', pack.offerVersionId) : undefined;
      return pack && offer ? { pack, offer, assets: offer.files.map(id => tx.get('asset', id)) } : undefined; });
    if (!snapshot || snapshot.pack.state === 'ready') return;
    if (snapshot.assets.some(a => !a || a.state !== 'available' || a.publicPreview || !same(a, job))) throw new CommerceError('package_content_unavailable', 409);
    const limit = await this.ports.assets.limitBytes(job.ownerId);
    if (snapshot.assets.reduce((n, a) => n + a!.byteLength, 0) > limit) throw new CommerceError('creator_storage_limit', 409);
    const files: { name: string; bytes: Uint8Array }[] = [];
    for (const asset of snapshot.assets) { const bytes = await this.ports.assets.read(asset!); if (bytes.length !== asset!.byteLength || hashBytes(bytes) !== asset!.checksum) throw new CommerceError('content_unavailable', 409);
      files.push({ name: asset!.id + '-' + asset!.label.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100), bytes }); }
    const stored = await this.ports.assets.putPackage(job, snapshot.pack.assetId, files, limit);
    await this.store.transaction(tx => { const pack = tx.get('package', job.referenceId)!;
      tx.put('asset', { ...this.base(job, pack.assetId), label: snapshot.offer.title + '.zip', contentType: 'application/zip', ...stored, state: 'available', publicPreview: false });
      pack.state = 'ready'; tx.put('package', pack); });
  }
  private async deliverDiscord(job: DeliveryJob) {
    const discord = this.ports.discord; if (!discord) throw new CommerceError('discord_unavailable', 503);
    const snapshot = await this.store.transaction(tx => ({ customer: tx.get('customer', job.referenceId), grants: tx.list('entitlement').filter(g => g.customerId === job.referenceId && same(g, job) && isActive(g, this.now()) && g.benefit.type === 'discord_role'),
      roles: tx.list('discordRole').filter(r => r.customerId === job.referenceId && same(r, job)) }));
    const userId = snapshot.customer?.discordUserId; if (!userId && !snapshot.roles.length) return;
    const targets = new Map<string, { guildId: string; roleId: string; userId: string; desired: boolean }>();
    for (const grant of snapshot.grants) if (userId && grant.benefit.type === 'discord_role') targets.set(key(grant.benefit.guildId, grant.benefit.roleId, userId), { guildId: grant.benefit.guildId, roleId: grant.benefit.roleId, userId, desired: true });
    for (const old of snapshot.roles) { const id = key(old.guildId, old.roleId, old.discordUserId); if (!targets.has(id)) targets.set(id, { guildId: old.guildId, roleId: old.roleId, userId: old.discordUserId, desired: false }); }
    for (const target of targets.values()) {
      // The same Discord role may be supported by several customers/creators.
      // Serialize its remote writes across all of them, not just one job ID.
      const lock = {...job,ownerId:'discord-role-'+key(target.guildId,target.roleId,target.userId),environment:'live' as const};
      await this.ports.withConnectionLock(lock,async()=>{
        const id = key('discord-role', job.ownerId, job.environment, job.referenceId, target.guildId, target.roleId, target.userId);
        const member = await discord.member(target.guildId, target.userId);
        const role = await this.store.transaction(tx => {
          const old = tx.get('discordRole', id), actual = member?.roles.includes(target.roleId) ?? false;
          const related = tx.list('discordRole').filter(r=>r.guildId===target.guildId&&r.roleId===target.roleId&&r.discordUserId===target.userId);
          const managed = related.some(r=>r.managed&&!r.preexisting);
          const desired = tx.list('entitlement').some(g=>g.benefit.type==='discord_role'&&g.benefit.guildId===target.guildId&&g.benefit.roleId===target.roleId&&isActive(g,this.now())&&tx.get('customer',g.customerId??'')?.discordUserId===target.userId);
          const record = old ?? {...this.base(job,id),customerId:job.referenceId,discordUserId:target.userId,guildId:target.guildId,roleId:target.roleId,managed,preexisting:actual&&!managed,desired,actual,status:'pending' as const};
          record.desired=desired;record.actual=actual;record.status=!member&&desired?'needs_membership':'pending';
          if(member&&desired&&!actual)record.managed=true;
          if(managed)record.managed=true;
          tx.put('discordRole',record);return record;
        });
        if(!member&&role.desired)throw new CommerceError('discord_membership_required',409);
        try {
          if(member&&role.desired&&!role.actual){await discord.validateRoles(target.guildId,[target.roleId]);await discord.addRole(target.guildId,target.userId,target.roleId);role.actual=true;}
          else if(member&&!role.desired&&role.actual&&role.managed&&!role.preexisting){await discord.validateRoles(target.guildId,[target.roleId]);await discord.removeRole(target.guildId,target.userId,target.roleId);role.actual=false;}
          role.status='delivered';role.lastError=undefined;
        }catch(error){role.status='conflict';role.lastError='discord_delivery_conflict';await this.store.transaction(tx=>{tx.put('discordRole',role);this.audit(tx,role,'worker','discord.conflict',role.id,role.lastError);});throw error;}
        await this.store.transaction(tx=>{
          // Revocation can occur during the provider call. Persist the observation,
          // then queue a fresh comparison rather than declaring stale intent current.
          const desired=tx.list('entitlement').some(g=>g.benefit.type==='discord_role'&&g.benefit.guildId===target.guildId&&g.benefit.roleId===target.roleId&&isActive(g,this.now())&&tx.get('customer',g.customerId??'')?.discordUserId===target.userId);
          role.desired=desired;tx.put('discordRole',role);
          if(desired!==role.actual&&(desired||role.managed&&!role.preexisting))this.queue(tx,job,'discord',job.referenceId);
          else if(tx.get('customer',job.referenceId)?.erasedAt)tx.remove('discordRole',role.id);
        });
      });
    }
  }
}
const hashBytes = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
