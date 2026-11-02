import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { CommerceError, CommerceService, type CommercePorts, type CommerceStore, type CreatorActor, type Environment, type PrivateAsset, type Scope } from '@ubeeq/commerce';
import { SqliteCommerceStore } from '@ubeeq/adapter-local';
import { PayPalConnections, PayPalCommerceProvider, PayPalError, DiscordCommerceClient, type CredentialVault, type PayPalConnection, type PayPalConnectionAudit, type PayPalConnectionStore, type PayPalFetch, type DiscordCommerceConfiguration } from '@ubeeq/integrations';
import { createWebsiteZip } from '@ubeeq/portability';
import type { ObjectStorage, StoredObject } from '@ubeeq/storage';
import { cellScopedObjectKey } from '@ubeeq/storage';
import { commerceHtml, commerceJavaScript } from './page.js';
import { renderWebsiteGalleryGroup, websiteGalleryViewerScript } from '@ubeeq/ui';

export interface CommerceRuntimeStore extends CommerceStore, PayPalConnectionStore {
  listConnections(ownerId?:string):Promise<PayPalConnection[]>;
  connectionAudits(ownerId:string):Promise<PayPalConnectionAudit[]>;
  purgeConnectionAudits?(before:string):Promise<void>;
  close():void;
}
export interface CommerceRuntimeConfiguration {
  /** Managed hosts supply their own durable adapter and encrypted vault. Local hosts default to SQLite. */
  store?: CommerceRuntimeStore;
  vault?: CredentialVault;
  productName?: string;
  tokenKey: string;
  /** Explicitly enable each eligible provider environment; absent configuration means unavailable. */
  environments: Environment[];
  eligibleCreatorIds?: string[];
  allowedOrigins?: string[];
  publicBaseUrl?: string;
  databasePath?: string;
  storageLimitBytes?: number;
  /** Required jurisdiction-specific policy, in days. This module never silently deletes financial records. */
  financialRetentionDays: number;
  reconciliationBatchSize?:number;
  recentPaymentDays?:number;
  assertOfferEligible?:CommercePorts['assertOfferEligible'];
  mail: CommercePorts['mail'];
  discord?: DiscordCommerceConfiguration;
  fetch?: PayPalFetch;
}
export interface CommerceRuntimeDependencies {
  deploymentId: string; cellId: string; publicBaseUrl: string; dataDirectory: string; vault: CredentialVault; storage: ObjectStorage;
  subject(request: IncomingMessage): Promise<string>;
  creator(subjectId: string, ownerId?:string): Promise<{ id: string; homeCellId: string }>;
  publicCreator?(ownerId:string):Promise<{displayName:string;handle?:string;bio?:string}|undefined>;
  contentAvailable(ownerId: string, assetId: string): Promise<boolean>;
  pruneCredentials?(referenced: string[], createdBefore: string): Promise<void>;
}
export function referenceCommerceConfigurationFromEnvironment(env: NodeJS.ProcessEnv): CommerceRuntimeConfiguration | undefined {
  if (env.UBEEQ_COMMERCE_ENABLED !== '1') return undefined;
  const endpoint = new URL(env.UBEEQ_COMMERCE_MAIL_ENDPOINT ?? '');
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !env.UBEEQ_COMMERCE_MAIL_TOKEN) throw new Error('Configure an HTTPS commerce mail relay and its authorization token.');
  const environments = (env.UBEEQ_PAYPAL_ENVIRONMENTS ?? 'sandbox').split(',').map(environment);
  return { tokenKey: env.UBEEQ_COMMERCE_TOKEN_KEY ?? '', environments, publicBaseUrl: env.UBEEQ_COMMERCE_PUBLIC_BASE_URL,
    eligibleCreatorIds: env.UBEEQ_COMMERCE_ELIGIBLE_CREATORS?.split(',').map(s => s.trim()).filter(Boolean),
    allowedOrigins: env.UBEEQ_COMMERCE_ALLOWED_ORIGINS?.split(',').map(s => new URL(s.trim()).origin),
    financialRetentionDays: Number(env.UBEEQ_COMMERCE_FINANCIAL_RETENTION_DAYS), storageLimitBytes: env.UBEEQ_COMMERCE_STORAGE_LIMIT_BYTES ? Number(env.UBEEQ_COMMERCE_STORAGE_LIMIT_BYTES) : undefined,
    reconciliationBatchSize:env.UBEEQ_COMMERCE_RECONCILIATION_BATCH?Number(env.UBEEQ_COMMERCE_RECONCILIATION_BATCH):undefined,recentPaymentDays:env.UBEEQ_COMMERCE_RECENT_PAYMENT_DAYS?Number(env.UBEEQ_COMMERCE_RECENT_PAYMENT_DAYS):undefined,
    mail: { send: async message => {
      let response: Response;
      try { response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { authorization: 'Bearer ' + env.UBEEQ_COMMERCE_MAIL_TOKEN, 'content-type': 'application/json', 'idempotency-key': message.idempotencyKey }, body: JSON.stringify(message) }); }
      catch { throw new CommerceError('mail_delivery_unavailable', 503); }
      await response.body?.cancel().catch(() => {}); if (!response.ok) throw new CommerceError('mail_delivery_unavailable', 503);
    } },
    ...(env.UBEEQ_DISCORD_CLIENT_ID ? { discord: { clientId: env.UBEEQ_DISCORD_CLIENT_ID, clientSecret: env.UBEEQ_DISCORD_CLIENT_SECRET ?? '',
      botToken: env.UBEEQ_DISCORD_BOT_TOKEN ?? '', botUserId: env.UBEEQ_DISCORD_BOT_USER_ID ?? '', redirectUri: env.UBEEQ_DISCORD_REDIRECT_URI ?? '' } } : {}) };
}
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const readBody = async (request: IncomingMessage, limit = 1024 * 1024): Promise<Buffer> => {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > limit) throw new CommerceError('payload_too_large', 413); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
};
const parseBody = async (request: IncomingMessage): Promise<any> => {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new CommerceError('json_required', 415);
  try { const data = JSON.parse((await readBody(request, 8 * 1024 * 1024)).toString('utf8')); if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error(); return data; }
  catch (error) { if (error instanceof CommerceError) throw error; throw new CommerceError('invalid_json'); }
};
const environment = (value: unknown): Environment => { if (value !== 'sandbox' && value !== 'live') throw new CommerceError('invalid_environment'); return value; };
const required = (value: unknown): string => { if (typeof value !== 'string' || !value || value.length > 10000) throw new CommerceError('invalid_request'); return value; };
const send = (response: ServerResponse, value: unknown, status = 200) => { response.statusCode = status; response.setHeader('content-type', 'application/json; charset=utf-8'); response.end(JSON.stringify(value)); };

export function createCommerceRuntime(config: CommerceRuntimeConfiguration, deps: CommerceRuntimeDependencies) {
  if (!Number.isSafeInteger(config.financialRetentionDays) || config.financialRetentionDays <= 0) throw new CommerceError('financial_retention_policy_required');
  const baseUrl = config.publicBaseUrl ?? deps.publicBaseUrl;
  const store = config.store ?? new SqliteCommerceStore(deps.deploymentId, config.databasePath ?? deps.dataDirectory + '/commerce.sqlite', config.tokenKey);
  if(store.deploymentId!==deps.deploymentId)throw new CommerceError('foreign_commerce_scope',403);
  const authorize = async (actor: CreatorActor) => { const creator = await deps.creator(actor.subjectId,actor.ownerId); if (creator.id !== actor.ownerId || creator.homeCellId !== deps.cellId) throw new CommerceError('creator_authorization_denied', 403); };
  const eligible = async (scope: Scope) => { if (scope.deploymentId !== deps.deploymentId || !config.environments.includes(scope.environment) || (config.eligibleCreatorIds && !config.eligibleCreatorIds.includes(scope.ownerId))) throw new CommerceError('payments_not_eligible', 403); };
  // Existing vaults are cell-local; deployment scope remains enforced before translating that selector.
  const vault: CredentialVault = {
    write: async input => { if (input.cellId !== deps.deploymentId) throw new CommerceError('foreign_deployment', 403); return deps.vault.write({ ...input, ownerId: 'paypal-commerce:' + input.ownerId, cellId: deps.cellId }); },
    read: async input => input.cellId === deps.deploymentId ? deps.vault.read({ ...input, cellId: deps.cellId }) : undefined,
    revoke: async input => { if (input.cellId !== deps.deploymentId) throw new CommerceError('foreign_deployment', 403); await deps.vault.revoke({ ...input, cellId: deps.cellId }); }
  };
  const connections = new PayPalConnections({ store, vault, callbackBaseUrl: baseUrl, fetch: config.fetch, checkoutReady: true,
    authorize: async actor => { if (actor.deploymentId !== deps.deploymentId) throw new CommerceError('foreign_deployment', 403); await authorize({ subjectId: actor.actorId, ownerId: actor.ownerId }); }, assertEnabled: eligible });
  const provider = new PayPalCommerceProvider({ publicBaseUrl: baseUrl, fetch: config.fetch, credentials: async (scope, id) => {
    const c = await store.get(deps.deploymentId, id);
    if (!c || c.ownerId !== scope.ownerId || c.environment !== scope.environment || scope.deploymentId !== deps.deploymentId || !c.credentialReference || c.state === 'disconnected') throw new CommerceError('payment_credentials_unavailable', 503);
    const secret = await vault.read({ cellId: deps.deploymentId, reference: c.credentialReference });
    if (!secret) throw new CommerceError('payment_credentials_unavailable', 503); return { clientId: c.clientId, clientSecret: Buffer.from(secret).toString('utf8'), merchantId: c.merchantId };
  } });
  const assetRead = async (asset: PrivateAsset) => {
    if (!await deps.contentAvailable(asset.ownerId, asset.id)) throw new CommerceError('content_unavailable', 409);
    let object: StoredObject; try { object = JSON.parse(asset.objectId); } catch { throw new CommerceError('content_unavailable', 409); }
    if (object.bucket !== deps.cellId || !object.key.startsWith(`cells/${deps.cellId}/creators/${asset.ownerId}/`) || object.scope !== 'private') throw new CommerceError('content_unavailable', 409);
    try { return (await deps.storage.get(object)).body; } catch { throw new CommerceError('content_unavailable', 409); }
  };
  const service = new CommerceService({ store, provider, publicBaseUrl: baseUrl, tokenKey: config.tokenKey, authorizeCreator: authorize, assertEligible: eligible,
    assertOfferEligible:async(scope,offer)=>{if(!await deps.contentAvailable(scope.ownerId,'')||!(await Promise.all(offer.files.map(id=>deps.contentAvailable(scope.ownerId,id)))).every(Boolean))throw new CommerceError('offer_not_eligible',403);await config.assertOfferEligible?.(scope,offer);},
    reconciliation:{batchSize:config.reconciliationBatchSize??100,recentPaymentDays:config.recentPaymentDays??30},
    withConnectionLock: (scope, operation) => store.withLock(scope, operation),
    withStorageLock: (scope, operation) => store.withLock({ ...scope, environment: 'live' }, operation),
    connection: async (ownerId, environment) => { const c = await store.find({ deploymentId: deps.deploymentId, ownerId, environment });
      if (!c || !c.acceptsCheckouts || !['configured','verified'].includes(c.state) || c.drainingUntil) throw new CommerceError('payment_connection_unavailable', 409); return { id: c.id, merchantId: c.merchantId }; },
    markVerified: async (scope, id, merchantId, at) => store.withLock(scope, async () => {
      const c = await store.get(deps.deploymentId, id); if (!c || c.state === 'disconnected') return;
      if (c.merchantId && c.merchantId !== merchantId) throw new CommerceError('connection_merchant_mismatch', 409);
      await store.save({ ...c, merchantId, state: c.state === 'action_required' ? c.state : 'verified', lastVerifiedPaymentAt: at, updatedAt: at, revision: c.revision + 1 }, c.revision,
        { actorId: 'payment-worker', action: 'paypal.payment_verified', at });
    }),
    bindMerchant: async (scope, id, merchantId) => store.withLock(scope, async () => {
      const c = await store.get(deps.deploymentId, id); if (!c || c.ownerId !== scope.ownerId || c.environment !== scope.environment || c.state === 'disconnected') throw new CommerceError('payment_connection_unavailable', 409);
      if (c.merchantId && c.merchantId !== merchantId) throw new CommerceError('connection_merchant_mismatch',409);
      if (!c.merchantId) await store.save({ ...c, merchantId, revision: c.revision+1 }, c.revision, { actorId: 'checkout-worker', action: 'paypal.merchant_bound', at: new Date().toISOString() });
    }),
    mail: config.mail, discord: config.discord ? new DiscordCommerceClient(config.discord) : undefined,
    discordTokens: {
      write: async (scope,value)=>(await vault.write({cellId:deps.deploymentId,ownerId:'discord-setup:'+scope.ownerId,value:Buffer.from(value),expiresAt:new Date(Date.now()+600000).toISOString()})).reference,
      read: async reference=>{const value=await vault.read({cellId:deps.deploymentId,reference});return value?Buffer.from(value).toString():undefined;},
      revoke: reference=>vault.revoke({cellId:deps.deploymentId,reference})
    },
    assets: { read: assetRead, limitBytes: async ownerId => (config.storageLimitBytes ?? 100 * 1024 * 1024) - await store.transaction(tx => tx.list('asset').filter(a => a.ownerId === ownerId).reduce((sum,a) => sum + a.byteLength,0)),
      putPackage: async (scope, id, files, maxBytes) => {
        const bytes = createWebsiteZip(new Map(files.map(f => [f.name, f.bytes]))); if (bytes.length > maxBytes) throw new CommerceError('creator_storage_limit', 409);
        const object: StoredObject = { bucket: deps.cellId, key: cellScopedObjectKey({ cellId: deps.cellId, creatorId: scope.ownerId, kind: 'uploads', objectId: 'commerce-package-' + id }),
          versionId: id, scope: 'private', contentType: 'application/zip', byteLength: bytes.length, checksum: digest(bytes) };
        await deps.storage.put({ object, body: bytes }); return { objectId: JSON.stringify(object), byteLength: bytes.length, checksum: object.checksum! };
      } }
  });
  let lastSchedule = 0;
  const runNextJob = async (workerId: string) => {
    if (Date.now() - lastSchedule > 60000) {
      await service.schedule(); lastSchedule = Date.now();
      await store.purgeConnectionAudits?.(new Date(Date.now()-365*86400000).toISOString());
      // Explicit app migrations retain old credentials/webhooks until their draining deadline.
      const recordedConnections=await store.listConnections();
      for (const c of recordedConnections) {
        const workerConnections = new PayPalConnections({ store, vault, callbackBaseUrl: baseUrl, fetch: config.fetch, authorize: async a => { if (a.actorId !== 'migration-worker' || a.ownerId !== c.ownerId) throw new CommerceError('authorization_denied',403); }, assertEnabled: eligible });
        if(c.retiredCredentialReferences.length)await workerConnections.retryCredentialCleanup({deploymentId:deps.deploymentId,ownerId:c.ownerId,actorId:'migration-worker'},c.environment,c.id);
        if (!(c.drainingUntil && c.drainingUntil <= new Date().toISOString() && c.state !== 'disconnected')) continue;
        if (await store.countUnconfirmedOrders(c)) {
          await store.withLock(c, async () => { const latest = await store.get(deps.deploymentId, c.id); if (!latest) return;
            if(latest.state==='action_required'&&latest.lastError==='migration_orders_require_reconciliation')return;
            await store.save({ ...latest, revision: latest.revision + 1, state: 'action_required', lastError: 'migration_orders_require_reconciliation' }, latest.revision,
              { actorId: 'worker', action: 'paypal.migration_reconciliation_required', at: new Date().toISOString() }); });
        } else {
          // Worker cleanup acts on recorded ownership, without impersonating an interactive creator.
          await workerConnections.disconnect({ deploymentId: deps.deploymentId, ownerId: c.ownerId, actorId: 'migration-worker' }, c.environment, c.id);
        }
      }
      if(deps.pruneCredentials){const references=recordedConnections.flatMap(c=>[c.credentialReference,c.pendingCredentialReference,...c.retiredCredentialReferences].filter((r):r is string=>!!r));
        references.push(...await store.transaction(tx=>tx.list('discordSetup').map(s=>s.credentialReference)));await deps.pruneCredentials(references,new Date(Date.now()-3600000).toISOString());}
    }
    return service.runNextJob(workerId);
  };
  const handle = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const path = url.pathname, method = request.method ?? 'GET';
    if(path.startsWith('/api/')&&!/^\/api\/(?:webhooks\/paypal\/|private-assets\/|previews\/|storefront$|auth\/email(?:\/|$)|me(?:$|\/(?:purchases$|purchase-claims\/|access$|gallery$|email(?:\/|$)|discord\/))|downloads\/|checkouts(?:$|\/)|connections\/paypal$|commerce\/|offers(?:$|\/)|discord\/)/.test(path))return false;
    if (!(path === '/commerce' || path.startsWith('/commerce/') || path.startsWith('/buy/') || path.startsWith('/api/'))) return false;
    const correlationId=randomUUID();response.setHeader('x-request-id',correlationId);
    response.setHeader('cache-control', 'private, no-store'); response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('referrer-policy', 'no-referrer');
    const origin = request.headers.origin;
    try {
      if (origin) { if (![new URL(baseUrl).origin, ...(config.allowedOrigins ?? [])].includes(origin)) throw new CommerceError('origin_not_allowed', 403);
        response.setHeader('access-control-allow-origin', origin); response.setHeader('vary', 'Origin'); response.setHeader('access-control-allow-headers', 'authorization, content-type, idempotency-key'); response.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS'); }
      if (method === 'OPTIONS') { response.statusCode = 204; response.end(); return true; }
      const ip = createHash('sha256').update(request.socket.remoteAddress ?? 'unknown').digest('hex');
      await service.rateLimit(ip, path.startsWith('/api/webhooks/') ? 'webhook_http' : 'commerce_http', 300, 60);
      if (method === 'GET' && path === '/commerce/client.js') { response.setHeader('content-type','text/javascript; charset=utf-8'); response.end(commerceJavaScript); return true; }
      if (method === 'GET' && path === '/commerce/gallery.js') { response.setHeader('content-type','text/javascript; charset=utf-8'); response.end(websiteGalleryViewerScript); return true; }
      if (method === 'GET' && (path === '/commerce' || path.startsWith('/commerce/') || path.startsWith('/buy/'))) {
        response.setHeader('content-type','text/html; charset=utf-8'); response.setHeader('content-security-policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"); response.end(commerceHtml.replaceAll('Creator purchases',((config.productName??'Creator')+' purchases').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))));  return true;
      }
      const webhook = path.match(/^\/api\/webhooks\/paypal\/([A-Za-z0-9_-]+)$/);
      if (method === 'POST' && webhook) {
        const raw = await readBody(request), incoming = new Headers();
        for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') incoming.set(name, value);
        send(response, { status: await connections.receive(deps.deploymentId, webhook[1], incoming, raw) }); return true;
      }
      const privateAsset = path.match(/^\/api\/private-assets\/([^/]+)$/), preview = path.match(/^\/api\/previews\/([^/]+)$/);
      if (method === 'GET' && (privateAsset || preview)) {
        const result = privateAsset ? await service.download(privateAsset[1], required(url.searchParams.get('token'))) : await service.preview(preview![1]);
        response.setHeader('content-type', result.asset.contentType); response.setHeader('content-length', result.bytes.length);
        response.setHeader('content-security-policy', "default-src 'none'; sandbox");
        response.setHeader('content-disposition', (result.asset.contentType.startsWith('image/') ? 'inline' : 'attachment') + '; filename="' + result.asset.label.replace(/[^A-Za-z0-9._-]/g, '_').slice(0,150) + '"'); response.end(Buffer.from(result.bytes)); return true;
      }
      if (method === 'GET' && path === '/api/storefront') { const ownerId=required(url.searchParams.get('owner'));send(response, { offers: await service.storefront(ownerId, environment(url.searchParams.get('environment') ?? 'live')),creator:await deps.publicCreator?.(ownerId) }); return true; }
      if (path === '/api/auth/email' && method === 'POST') { const b = await parseBody(request); send(response, await service.beginEmailLogin(required(b.email)), 202); return true; }
      if (path === '/api/auth/email/redeem' && method === 'POST') { const b = await parseBody(request); send(response, await service.redeemEmailLogin(required(b.id), required(b.token))); return true; }
      let subjectId: string;
      try { subjectId = await deps.subject(request); }
      catch (error) { const resolved = await service.customerSubject(request.headers.authorization?.replace(/^Bearer\s+/i,'') ?? ''); if (!resolved) throw error; subjectId = resolved; }
      // A customer magic-link session carries no creator management authority, even for the same email/subject.
      const actor = async (): Promise<CreatorActor> => { const managementSubject = await deps.subject(request); return { subjectId: managementSubject, ownerId: (await deps.creator(managementSubject,url.searchParams.get('owner')??undefined)).id }; };
      if (path === '/api/me' && method === 'GET') { send(response, await service.customerProfile(subjectId)); return true; }
      if (path === '/api/me' && method === 'DELETE') { send(response, await service.eraseCustomer(subjectId)); return true; }
      if (path === '/api/me/purchase-claims/resend' && method === 'POST') { send(response, await service.recoverClaims(subjectId), 202); return true; }
      if (path === '/api/me/discord/retry' && method === 'POST') { send(response, await service.retryCustomerDiscord(subjectId),202);return true; }
      if (path === '/api/me/purchases' && method === 'GET') { send(response, { purchases: await service.purchases(subjectId) }); return true; }
      if (path === '/api/me/access' && method === 'GET') { send(response, await service.myAccess(subjectId)); return true; }
      if (path === '/api/me/gallery' && method === 'GET') {
        const purchase = (await service.purchases(subjectId)).find(p => p.id === url.searchParams.get('purchase'));
        if (!purchase?.offer) throw new CommerceError('purchase_not_found', 404);
        const access = await service.myAccess(subjectId), photos: { src: string; thumbnail: string; title: string; alt: string }[] = [];
        for (const id of purchase.offer.files) {
          const asset = access.assets.find(a => a.id === id); if (!asset?.contentType.startsWith('image/') || asset.state !== 'available') continue;
          const authorized = await service.authorizeDownload(subjectId, id); photos.push({ src: authorized.url, thumbnail: authorized.url, title: asset.label, alt: asset.label });
        }
        send(response, { html: renderWebsiteGalleryGroup([{ id: purchase.id, title: purchase.offer.title, href: '/commerce/purchases', photos }], purchase.id), refreshAfterSeconds: 240 }); return true;
      }
      if (path === '/api/me/email' && method === 'POST') { const b = await parseBody(request); send(response, await service.beginEmailVerification(subjectId, required(b.email)), 202); return true; }
      if (path === '/api/me/email/verify' && method === 'POST') { const b = await parseBody(request); send(response, await service.verifyEmail(subjectId, required(b.id), required(b.token))); return true; }
      if (path === '/api/purchase-claims' && method === 'POST') { const b = await parseBody(request); send(response, await service.redeemClaim(subjectId, required(b.id), required(b.token))); return true; }
      const download = path.match(/^\/api\/downloads\/([^/]+)\/authorize$/);
      if (download && method === 'POST') { send(response, await service.authorizeDownload(subjectId, download[1])); return true; }
      if (path === '/api/checkouts' && method === 'POST') { const b = await parseBody(request); send(response, { order: await service.checkout(subjectId, required(b.offerVersionId), required(request.headers['idempotency-key'])) }, 202); return true; }
      const order = path.match(/^\/api\/checkouts\/([^/]+)(\/capture)?$/);
      if (order && method === 'GET' && !order[2]) { send(response, await service.order(subjectId, order[1])); return true; }
      if (order && method === 'POST' && order[2]) { send(response, await service.capture(subjectId, order[1]), 202); return true; }
      if (path === '/api/connections/paypal') {
        const a = await actor(), paypalActor = { deploymentId: deps.deploymentId, ownerId: a.ownerId, actorId: subjectId };
        if (method === 'GET') { const connection=await connections.get(paypalActor, environment(url.searchParams.get('environment') ?? 'sandbox'));
          const last=connection?await store.transaction(tx=>tx.list('event').filter(e=>e.connectionId===connection.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0]?.createdAt):undefined;
          send(response, { connection:connection?{...connection,lastVerifiedEventAt:last}:undefined }); return true; }
        const b = await parseBody(request);
        if (method === 'POST') { send(response, { connection: await connections.connect(paypalActor, { environment: environment(b.environment), clientId: required(b.clientId), clientSecret: required(b.clientSecret), migrationUntil: b.migrationUntil }) }); return true; }
        if (method === 'DELETE') { send(response, { connection: await connections.disconnect(paypalActor, environment(b.environment), b.connectionId) }); return true; }
      }
      if (path === '/api/commerce/history' && method === 'GET') { const a=await actor(); send(response, {...await service.creatorHistory(a),connections:await connections.list({deploymentId:deps.deploymentId,ownerId:a.ownerId,actorId:a.subjectId}),connectionAudits:await store.connectionAudits(a.ownerId)}); return true; }
      if (path === '/api/offers' && method === 'POST') { const b = await parseBody(request); send(response, { offer: await service.publishOffer(await actor(), b) }, 201); return true; }
      const offerVisibility = path.match(/^\/api\/offers\/([^/]+)\/visibility$/);
      if (offerVisibility && method === 'POST') { const b = await parseBody(request); await service.setOfferPublished(await actor(), offerVisibility[1], b.published === true); send(response, { updated: true }); return true; }
      if (path === '/api/commerce/assets' && method === 'POST') {
        const a = await actor(), b = await parseBody(request), env = environment(b.environment);
        await store.withLock({ deploymentId: deps.deploymentId, ownerId: a.ownerId, environment: 'live' }, async () => {
        if (typeof b.base64 !== 'string' || b.base64.length > 7 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.base64)) throw new CommerceError('invalid_asset');
        const bytes = Buffer.from(b.base64, 'base64');
        await authorize(a); if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new CommerceError('invalid_asset');
        const checksum = digest(bytes), publicPreview = b.publicPreview === true;
        const existing = await store.transaction(tx => tx.list('asset').filter(asset => asset.ownerId === a.ownerId));
        if (existing.some(asset => asset.checksum === checksum && asset.publicPreview !== publicPreview)) throw new CommerceError('public_preview_requires_separate_derivative');
        const mime = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
          : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' ? 'image/webp' : 'application/octet-stream';
        if (publicPreview && !mime.startsWith('image/')) throw new CommerceError('public_preview_image_required');
        if (existing.reduce((sum, asset) => sum + asset.byteLength, 0) + bytes.length > (config.storageLimitBytes ?? 100 * 1024 * 1024)) throw new CommerceError('creator_storage_limit', 409);
        const object: StoredObject = { bucket: deps.cellId, key: cellScopedObjectKey({ cellId: deps.cellId, creatorId: a.ownerId, kind: 'uploads', objectId: 'commerce-' + randomUUID() }), versionId: randomUUID(),
          contentType: mime, scope: 'private', byteLength: bytes.length, checksum };
        await deps.storage.put({ object, body: bytes });
        try { send(response, { asset: await service.registerAsset(a, env, { label: required(b.label).slice(0,200), contentType: mime, byteLength: bytes.length, checksum,
          objectId: JSON.stringify(object), state: 'available', publicPreview }) }, 201); }
        catch (error) { await deps.storage.remove(object).catch(() => {}); throw error; }
        }); return true;
      }
      const availability = path.match(/^\/api\/commerce\/assets\/([^/]+)\/availability$/);
      if (availability && method === 'POST') { const b = await parseBody(request); await service.setAssetAvailability(await actor(), availability[1], b.available === true); send(response, { updated: true }); return true; }
      const retry = path.match(/^\/api\/commerce\/purchases\/([^/]+)\/(recheck|retry-discord|resend-claim)$/);
      if (retry && method === 'POST') {
        const a = await actor(); if (retry[2] === 'resend-claim') send(response, await service.resendClaim(a, retry[1]));
        else { await service.retry(a, retry[2] === 'recheck' ? 'reconcile' : 'discord', retry[1]); send(response, { queued: true }); } return true;
      }
      if (path === '/api/commerce/grants' && method === 'POST') { send(response, { grant: await service.manualGrant(await actor(), await parseBody(request)) }, 201); return true; }
      const revoke = path.match(/^\/api\/commerce\/grants\/([^/]+)\/revoke$/);
      if (revoke && method === 'POST') { const b = await parseBody(request); await service.revoke(await actor(), revoke[1], required(b.reason)); send(response, { revoked: true }); return true; }
      if (path === '/api/commerce/external-mappings/validate' && method === 'POST') { const b = await parseBody(request); send(response, await service.validateExternalMapping(await actor(), required(b.offerId), required(b.paymentId))); return true; }
      if (path === '/api/discord/authorize' && method === 'POST') { const b = await parseBody(request); send(response, await service.beginDiscord(subjectId, b.creator === true ? await actor() : undefined, environment(b.environment ?? 'live'))); return true; }
      if (path === '/api/discord/callback' && method === 'POST') { const b = await parseBody(request),flow=await service.discordFlow(subjectId,required(b.state)); if(flow.creator){const managementSubject=await deps.subject(request);await deps.creator(managementSubject,flow.ownerId);} send(response, await service.completeDiscord(subjectId, required(b.state), required(b.code), b.guild)); return true; }
      if (path === '/api/discord/creator/roles' && method === 'GET') { send(response,{roles:await service.discordSetupRoles(await actor(),required(url.searchParams.get('session')),required(url.searchParams.get('guild')))});return true; }
      if (path === '/api/discord/creator/configure' && method === 'POST') { const b=await parseBody(request);send(response,await service.configureDiscordSetup(await actor(),required(b.sessionId),b.guild));return true; }
      throw new CommerceError('commerce_route_not_found', 404);
    } catch (error) {
      const paypal = error instanceof PayPalError;
      const code = error instanceof CommerceError || paypal ? error.code : 'commerce_unavailable';
      const authError = error as { status?: number; code?: string };
      const trustedHttp = [401,403,404].includes(authError.status ?? 0) && typeof authError.code === 'string' && /^[a-z_]{1,80}$/.test(authError.code);
      const status = error instanceof CommerceError ? error.status : paypal ? (['provider_outcome_unknown','provider_invalid_response','rate_limited','credentials_unavailable','connection_busy'].includes(code)
        || (path.startsWith('/api/webhooks/') && ['invalid_credentials','missing_permissions'].includes(code)) ? 503 : 400) : trustedHttp ? authError.status! : 503;
      if(path.startsWith('/api/webhooks/paypal/')){const c=await store.get(deps.deploymentId,path.split('/').at(-1)??'').catch(()=>undefined);
        if(c)await service.operationalIssue(c,code,correlationId).catch(()=>{});}
      send(response, { error: { code: trustedHttp ? authError.code : code, requestId:correlationId } }, status); return true;
    }
  };
  return { handle, runNextJob, close: () => store.close(), service, store, connections };
}
