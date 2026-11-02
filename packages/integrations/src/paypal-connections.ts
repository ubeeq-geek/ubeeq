import { randomUUID } from 'node:crypto';
import type { CredentialVault } from './index.js';
import { PayPalClient, PayPalError, PAYPAL_EVENT_TYPES, type PayPalEnvironment, type PayPalFetch } from './paypal-client.js';

export interface PayPalScope { deploymentId: string; ownerId: string; environment: PayPalEnvironment; }
export interface PayPalActor { deploymentId: string; ownerId: string; actorId: string; }
export type PayPalConnectionState = 'validating' | 'configured' | 'verified' | 'action_required' | 'disconnected';
/** Restricted backend record. Never serialize this record to the creator or a generated website. */
export interface PayPalConnection extends PayPalScope {
  id: string;
  revision: number;
  clientId: string;
  label?: string;
  merchantId?: string;
  drainingUntil?: string;
  credentialReference?: string;
  pendingCredentialReference?: string;
  retiredCredentialReferences: string[];
  webhookId?: string;
  webhookUrl: string;
  subscribedEvents: string[];
  state: PayPalConnectionState;
  acceptsCheckouts: boolean;
  lastError?: string;
  registrationOutcomeUnknown?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Only the future authoritative payment processor may set this after merchant/order reconciliation. */
  lastVerifiedPaymentAt?: string;
}
export interface PayPalConnectionStatus extends PayPalScope {
  id: string; label?:string; maskedClientId: string; webhookId?: string; webhookUrl: string;
  state: PayPalConnectionState; acceptsCheckouts: boolean; lastError?: string;
  lastVerifiedPaymentAt?: string; credentialCleanupPending: boolean;
  merchantId?: string; drainingUntil?: string;
}
export interface PayPalConnectionAudit { actorId: string; action: string; at: string; code?: string; }
export interface PayPalEventConnection extends PayPalScope { id: string; }

/** All operations are deployment scoped; implementations must enforce the constraints in PAYPAL-CREATOR-PAYMENTS.md. */
export interface PayPalConnectionStore {
  /** Cross-process exclusive lease, held/renewed through provider calls; reject stale writers. */
  withLock<T>(scope: PayPalScope, operation: () => Promise<T>): Promise<T>;
  find(scope: PayPalScope): Promise<PayPalConnection | undefined>;
  get(deploymentId: string, connectionId: string): Promise<PayPalConnection | undefined>;
  /** Atomic compare-and-swap plus append-only audit. Unique active deployment/owner/environment/client app and opaque ID. */
  save(record: PayPalConnection, expectedRevision: number, audit: PayPalConnectionAudit): Promise<void>;
  countUnconfirmedOrders(connection: PayPalConnection): Promise<number>;
  listConnections?(ownerId?: string): Promise<PayPalConnection[]>;
  archive?(connection: PayPalConnection, deadline: string, audit: PayPalConnectionAudit): Promise<void>;
  /** Atomic unique insert + processing job. Resolve only after durable commit; duplicate is success.
   * Key: deploymentId, connectionId, environment, eventId. Raw payload requires restricted, expiring retention.
   */
  acceptEvent(input: { connection: PayPalEventConnection; eventId: string; eventType: string; rawBody: Uint8Array; receivedAt: string }): Promise<'accepted' | 'duplicate'>;
}
export interface PayPalConnectionPorts {
  store: PayPalConnectionStore;
  vault: CredentialVault;
  /** Configured backend base, including any route prefix. Never derived from Host or request data. */
  callbackBaseUrl: string;
  authorize(actor: PayPalActor, action: 'read' | 'manage'): Promise<void>;
  /** Product/content eligibility gate; default deployment configuration must disable payments. */
  assertEnabled(scope: PayPalScope): Promise<void>;
  fetch?: PayPalFetch;
  now?: () => Date;
  checkoutReady?: boolean;
}

const status = (c: PayPalConnection): PayPalConnectionStatus => ({
  id: c.id, deploymentId: c.deploymentId, ownerId: c.ownerId, environment: c.environment,
  label: c.label, maskedClientId: '••••' + c.clientId.slice(-4), webhookId: c.webhookId, webhookUrl: c.webhookUrl,
  state: c.state, acceptsCheckouts: c.acceptsCheckouts, lastError: c.lastError,
  lastVerifiedPaymentAt: c.lastVerifiedPaymentAt, credentialCleanupPending: c.retiredCredentialReferences.length > 0
  , merchantId: c.merchantId, drainingUntil: c.drainingUntil
});
const errorCode = (error: unknown) => error instanceof PayPalError ? error.code : 'connection_operation_failed';

/** First implementation stage: webhook lifecycle and verified durable intake, without fulfillment. */
export class PayPalConnections {
  private readonly callbackBase: string;
  constructor(private readonly ports: PayPalConnectionPorts) {
    let url: URL;
    try { url = new URL(ports.callbackBaseUrl); } catch { throw new PayPalError('invalid_callback_base'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new PayPalError('invalid_callback_base');
    this.callbackBase = url.href.replace(/\/$/, '');
  }
  private now() { return (this.ports.now?.() ?? new Date()).toISOString(); }
  private scope(actor: PayPalActor, environment: PayPalEnvironment): PayPalScope {
    if (!actor.deploymentId || !actor.ownerId || !actor.actorId || !['sandbox', 'live'].includes(environment)) throw new PayPalError('invalid_scope');
    return { deploymentId: actor.deploymentId, ownerId: actor.ownerId, environment };
  }
  private async save(c: PayPalConnection, actorId: string, action: string, code?: string) {
    const next = { ...c, revision: c.revision + 1, updatedAt: this.now() };
    await this.ports.store.save(structuredClone(next), c.revision, { actorId, action, code, at: next.updatedAt });
    Object.assign(c, next);
  }
  async get(actor: PayPalActor, environment: PayPalEnvironment,connectionId?:string): Promise<PayPalConnectionStatus | undefined> {
    await this.ports.authorize(actor, 'read');
    const scope=this.scope(actor,environment),c=connectionId?await this.ports.store.get(scope.deploymentId,connectionId):await this.ports.store.find(scope);
    if(c&&(c.ownerId!==scope.ownerId||c.environment!==environment))throw new PayPalError('connection_not_found');
    if(!c&&!connectionId&&this.ports.store.listConnections&&(await this.ports.store.listConnections(scope.ownerId)).filter(c=>c.environment===environment&&!c.drainingUntil).length>1)throw new PayPalError('connection_selection_required');
    return c ? status(c) : undefined;
  }
  async list(actor: PayPalActor) {
    await this.ports.authorize(actor, 'read');
    if (!this.ports.store.listConnections) return [];
    return (await this.ports.store.listConnections(actor.ownerId)).filter(c => c.deploymentId === actor.deploymentId && c.ownerId === actor.ownerId).map(status);
  }
  async retryCredentialCleanup(actor: PayPalActor, environment: PayPalEnvironment, id: string) {
    await this.ports.authorize(actor, 'manage'); const scope = this.scope(actor,environment);
    return this.ports.store.withLock(scope,async()=>{const c=await this.ports.store.get(scope.deploymentId,id);
      if(!c || c.ownerId!==scope.ownerId || c.environment!==environment)throw new PayPalError('connection_not_found');
      await this.cleanup(c,actor.actorId);return status(c);
    });
  }
  private client(c: PayPalConnection, clientSecret: string) { return new PayPalClient(c.environment, { clientId: c.clientId, clientSecret }, this.ports.fetch); }
  private async storedClient(c: PayPalConnection) {
    if (!c.credentialReference) throw new PayPalError('credentials_unavailable');
    const bytes = await this.ports.vault.read({ cellId: c.deploymentId, reference: c.credentialReference });
    if (!bytes) throw new PayPalError('credentials_unavailable');
    return this.client(c, Buffer.from(bytes).toString('utf8'));
  }
  /** Retired refs remain durably discoverable when revocation fails; repeat Connect/Disconnect retries cleanup. */
  private async cleanup(c: PayPalConnection, actorId: string) {
    for (const reference of [...c.retiredCredentialReferences]) {
      try { await this.ports.vault.revoke({ cellId: c.deploymentId, reference }); } catch { continue; }
      c.retiredCredentialReferences = c.retiredCredentialReferences.filter(value => value !== reference);
      await this.save(c, actorId, 'paypal.credential_retired');
    }
  }
  async connect(actor: PayPalActor, input: { environment: PayPalEnvironment; clientId?: string; clientSecret: string; migrationUntil?: string;connectionId?:string;createNew?:boolean;label?:string }): Promise<PayPalConnectionStatus> {
    await this.ports.authorize(actor, 'manage');
    const scope = this.scope(actor, input.environment);
    await this.ports.assertEnabled(scope);
    if(input.connectionId!==undefined&&(typeof input.connectionId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(input.connectionId)))throw new PayPalError('invalid_connection_command');
    if(input.clientId!==undefined&&typeof input.clientId!=='string')throw new PayPalError('invalid_credentials');
    if(input.createNew!==undefined&&typeof input.createNew!=='boolean')throw new PayPalError('invalid_connection_command');
    if(input.connectionId&&input.createNew)throw new PayPalError('invalid_connection_command');
    if(input.label!==undefined&&(typeof input.label!=='string'||!input.label.trim()||input.label.trim().length>120))throw new PayPalError('invalid_connection_label');
    return this.ports.store.withLock(scope, async () => {
      let prior:PayPalConnection|undefined;
      if(input.connectionId){prior=await this.ports.store.get(scope.deploymentId,input.connectionId);if(!prior||prior.ownerId!==scope.ownerId||prior.environment!==scope.environment||prior.drainingUntil)throw new PayPalError('connection_not_found');}
      else if(input.createNew){
        if(!this.ports.store.listConnections)throw new PayPalError('multiple_connections_unavailable');
        if((await this.ports.store.listConnections(scope.ownerId)).some(c=>c.deploymentId===scope.deploymentId&&c.environment===scope.environment&&!c.drainingUntil&&c.clientId===input.clientId))throw new PayPalError('connection_already_exists');
      }else{prior=await this.ports.store.find(scope);if(!prior&&this.ports.store.listConnections&&(await this.ports.store.listConnections(scope.ownerId)).some(c=>c.deploymentId===scope.deploymentId&&c.environment===scope.environment&&!c.drainingUntil))throw new PayPalError('connection_selection_required');}
      const clientId=input.clientId?.trim()||prior?.clientId;
      if(!clientId)throw new PayPalError('invalid_credentials');
      new PayPalClient(input.environment,{clientId,clientSecret:input.clientSecret},this.ports.fetch);

      if (prior && prior.clientId !== clientId) {
        if (!input.migrationUntil || !this.ports.store.archive) throw new PayPalError('app_replacement_requires_migration');
        const deadline = Date.parse(input.migrationUntil), current = Date.parse(this.now());
        if (!Number.isFinite(deadline) || deadline <= current || deadline > current + 90 * 86400000) throw new PayPalError('invalid_migration_deadline');
        await this.ports.store.archive(prior, new Date(deadline).toISOString(), { actorId: actor.actorId, action: 'paypal.app_migration_started', at: this.now() });
        prior = undefined;
      }
      const c: PayPalConnection = prior ? structuredClone(prior) : {
        ...scope, id: randomUUID(), revision: 0, clientId, retiredCredentialReferences: [],
        webhookUrl: '', subscribedEvents: [], state: 'validating', acceptsCheckouts: false, createdAt: this.now(), updatedAt: this.now()
      };
      if(input.label!==undefined)c.label=input.label.trim();
      const callback = this.callbackBase + '/api/webhooks/paypal/' + c.id;
      // A permanently rejected registration created no hook; allow repairing its endpoint.
      if(c.webhookUrl&&c.webhookUrl!==callback){
        if(c.state!=='disconnected'&&(c.webhookId||c.registrationOutcomeUnknown||!['provider_rejected','invalid_credentials'].includes(c.lastError??'')))throw new PayPalError('callback_change_requires_review');
        c.webhookUrl=callback;
      }
      c.webhookUrl ||= callback;
      const stored = await this.ports.vault.write({ cellId: c.deploymentId, ownerId: c.ownerId, value: Buffer.from(input.clientSecret) });
      if (c.pendingCredentialReference) c.retiredCredentialReferences.push(c.pendingCredentialReference);
      c.pendingCredentialReference = stored.reference;
      if(c.lastError==='provider_outcome_unknown')c.registrationOutcomeUnknown=true;
      c.state = 'validating'; c.acceptsCheckouts = false; c.lastError = undefined;
      try { await this.save(c, actor.actorId, 'paypal.connect_started'); }
      catch (error) { await this.ports.vault.revoke({ cellId: c.deploymentId, reference: stored.reference }).catch(() => {}); throw error; }
      try {
        const client = this.client(c, input.clientSecret);
        const matching = (await client.listWebhooks()).filter(hook => hook.url === c.webhookUrl);
        if (matching.length > 1) throw new PayPalError('duplicate_managed_webhooks');
        // Exact opaque, persisted callback ownership permits recovery after a lost create response.
        let hook = matching[0] ?? await client.createWebhook(c.webhookUrl);
        if (hook.url !== c.webhookUrl) throw new PayPalError('webhook_registration_mismatch');
        if (PAYPAL_EVENT_TYPES.some(name => !hook.event_types.some(event => event.name === name))) hook = await client.updateWebhook(hook.id);
        if (hook.url !== c.webhookUrl || PAYPAL_EVENT_TYPES.some(name => !hook.event_types.some(event => event.name === name)))
          throw new PayPalError('webhook_registration_mismatch');
        c.registrationOutcomeUnknown=false;
        c.webhookId = hook.id; c.subscribedEvents = hook.event_types.map(event => event.name);
        if (c.credentialReference) c.retiredCredentialReferences.push(c.credentialReference);
        c.credentialReference = stored.reference; c.pendingCredentialReference = undefined;
        // Registration alone can never establish a verified payment or merchant identity.
        c.state = c.lastVerifiedPaymentAt ? 'verified' : 'configured';
        c.acceptsCheckouts = this.ports.checkoutReady === true;
        await this.save(c, actor.actorId, 'paypal.configured');
      } catch (error) {
        // Reload committed state: a failed commit must not retire the working credential.
        const committed = await this.ports.store.get(scope.deploymentId,c.id);
        if (!committed) throw error;
        committed.state = 'action_required'; committed.acceptsCheckouts = false; committed.lastError = errorCode(error);
        if(committed.lastError==='provider_outcome_unknown')committed.registrationOutcomeUnknown=true;
        await this.save(committed, actor.actorId, 'paypal.connect_failed', committed.lastError);
        throw error instanceof PayPalError ? error : new PayPalError('connection_operation_failed');
      }
      await this.cleanup(c, actor.actorId);
      return status(c);
    });
  }
  async rename(actor:PayPalActor,environment:PayPalEnvironment,connectionId:string,label:string){
    await this.ports.authorize(actor,'manage');const scope=this.scope(actor,environment);
    if(typeof connectionId!=='string'||!connectionId)throw new PayPalError('connection_not_found');
    if(typeof label!=='string'||!label.trim()||label.trim().length>120)throw new PayPalError('invalid_connection_label');
    return this.ports.store.withLock(scope,async()=>{const c=await this.ports.store.get(scope.deploymentId,connectionId);if(!c||c.ownerId!==scope.ownerId||c.environment!==environment||c.drainingUntil)throw new PayPalError('connection_not_found');c.label=label.trim();await this.save(c,actor.actorId,'paypal.connection_renamed');return status(c);});
  }
  async disconnect(actor: PayPalActor, environment: PayPalEnvironment, connectionId?: string): Promise<PayPalConnectionStatus> {
    await this.ports.authorize(actor, 'manage');
    const scope = this.scope(actor, environment);
    return this.ports.store.withLock(scope, async () => {
      const c = connectionId ? await this.ports.store.get(scope.deploymentId, connectionId) : await this.ports.store.find(scope);
      if (!c || c.ownerId !== scope.ownerId || c.environment !== scope.environment) throw new PayPalError('connection_not_found');
      if (await this.ports.store.countUnconfirmedOrders(c)) throw new PayPalError('unconfirmed_orders_require_reconciliation');
      c.acceptsCheckouts = false;
      c.state = 'action_required'; c.lastError = 'disconnect_cleanup_pending';
      await this.save(c, actor.actorId, 'paypal.disconnect_started');
      try {
        // Registration may have succeeded even if the response never reached us. Discover by exact URL.
        if (c.credentialReference || c.pendingCredentialReference) {
          const client = await this.storedClient({ ...c, credentialReference: c.credentialReference ?? c.pendingCredentialReference });
          const hooks = (await client.listWebhooks()).filter(hook => hook.url === c.webhookUrl);
          for (const hook of hooks) await client.deleteWebhook(hook.id);
        }
      } catch (error) {
        c.lastError = errorCode(error);
        await this.save(c, actor.actorId, 'paypal.disconnect_failed', c.lastError);
        return status(c);
      }
      for (const reference of [c.credentialReference, c.pendingCredentialReference]) if (reference) c.retiredCredentialReferences.push(reference);
      c.credentialReference = undefined; c.pendingCredentialReference = undefined; c.webhookId = undefined;
      c.subscribedEvents = []; c.state = 'disconnected'; c.lastError = undefined;
      await this.save(c, actor.actorId, 'paypal.disconnected');
      await this.cleanup(c, actor.actorId);
      return status(c);
    });
  }
  /** HTTP adapter must bound bytes while reading, rate limit intake, and return 2xx only after this resolves.
   * No event-declared owner is consulted. Deployment ID comes from backend configuration.
   */
  async receive(deploymentId: string, connectionId: string, headers: Headers, rawBody: Uint8Array): Promise<'accepted' | 'duplicate'> {
    if (!deploymentId || !/^[A-Za-z0-9_-]{1,200}$/.test(connectionId)) throw new PayPalError('connection_not_found');
    const c = await this.ports.store.get(deploymentId, connectionId);
    if (!c || c.deploymentId !== deploymentId || c.id !== connectionId || c.state === 'disconnected' || !c.webhookId)
      throw new PayPalError('connection_not_found');
    const client = await this.storedClient(c);
    const event = await client.verifyWebhook(c.webhookId, headers, rawBody);
    const connection: PayPalEventConnection = { id: c.id, deploymentId: c.deploymentId, ownerId: c.ownerId, environment: c.environment };
    return this.ports.store.acceptEvent({ connection, eventId: event.id, eventType: event.event_type, rawBody: rawBody.slice(), receivedAt: this.now() });
  }
}
