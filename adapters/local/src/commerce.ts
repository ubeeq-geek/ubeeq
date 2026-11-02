import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CommerceError, type CommerceRecords, type CommerceStore, type CommerceTransaction, type RecordBase } from '@ubeeq/commerce';
import { PayPalError, type PayPalConnection, type PayPalConnectionAudit, type PayPalConnectionStore, type PayPalScope } from '@ubeeq/integrations';
import type { WebsiteSqliteConnection } from './websites.js';

/** Dedicated durable commerce database. Network work happens outside short SQL transactions. */
export class SqliteCommerceStore implements CommerceStore, PayPalConnectionStore {
  private readonly db: WebsiteSqliteConnection;
  private readonly encryptionKey: Buffer;
  private readonly lockContext = new AsyncLocalStorage<{ key: string; token: string; valid: boolean }>();
  constructor(readonly deploymentId: string, path: string, encryptionKey: string) {
    if (!deploymentId || encryptionKey.length < 32) throw new CommerceError('commerce_storage_configuration_required');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path); if (path !== ':memory:') chmodSync(path, 0o600);
    this.encryptionKey = createHash('sha256').update('commerce-payload:' + encryptionKey).digest();
    this.db.exec(`PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS commerce_records(deployment TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,environment TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(deployment,kind,id));
      CREATE INDEX IF NOT EXISTS commerce_records_scope ON commerce_records(deployment,kind,owner,environment);
      CREATE TABLE IF NOT EXISTS commerce_uniques(deployment TEXT NOT NULL,kind TEXT NOT NULL,key TEXT NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(deployment,kind,key));
      CREATE TABLE IF NOT EXISTS commerce_connections(deployment TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,environment TEXT NOT NULL,active INTEGER NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(deployment,id));
      DROP INDEX IF EXISTS commerce_connection_active;
      CREATE UNIQUE INDEX IF NOT EXISTS commerce_connection_client ON commerce_connections(deployment,owner,environment,json_extract(payload,'$.clientId')) WHERE active=1;
      CREATE TABLE IF NOT EXISTS commerce_connection_audit(id TEXT PRIMARY KEY,deployment TEXT NOT NULL,connection TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commerce_locks(scope TEXT PRIMARY KEY,token TEXT NOT NULL,expires INTEGER NOT NULL);`);
  }
  close() { this.db.close(); }
  private atomic<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); if (result && typeof (result as any).then === 'function') throw new CommerceError('async_commerce_transaction_forbidden'); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private seal(value: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
  }
  private open(value: string) {
    const data = JSON.parse(value), decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(data.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(data.tag, 'base64')); return Buffer.concat([decipher.update(Buffer.from(data.ciphertext, 'base64')), decipher.final()]).toString();
  }
  private encode(kind: string, value: RecordBase): string {
    const record = structuredClone(value) as any;
    if (kind === 'event' && record.payload) record.payload = this.seal(record.payload);
    return JSON.stringify(record);
  }
  private decode<K extends keyof CommerceRecords>(kind: K, payload: string): CommerceRecords[K] {
    const value = JSON.parse(payload); if (kind === 'event' && value.payload) value.payload = this.open(value.payload); return value;
  }
  async transaction<T>(operation: (tx: CommerceTransaction) => T): Promise<T> {
    return this.atomic(() => {
      let active=true;const requireActive=()=>{if(!active)throw new CommerceError('commerce_transaction_ended');};
      const context=this.lockContext.getStore();
      if(context){const lease=this.db.prepare('SELECT token,expires FROM commerce_locks WHERE scope=?').get(context.key) as {token:string;expires:number}|undefined;
        if(!context.valid||lease?.token!==context.token||lease.expires<Date.now())throw new PayPalError('connection_lock_lost');}
      const get: CommerceTransaction['get'] = (kind, id) => {
        requireActive();
        const row = this.db.prepare('SELECT payload FROM commerce_records WHERE deployment=? AND kind=? AND id=?').get(this.deploymentId, kind, id) as { payload: string } | undefined;
        return row ? this.decode(kind, row.payload) : undefined;
      };
      const validate = (record: RecordBase) => { requireActive();if (record.deploymentId !== this.deploymentId || !record.id || !record.ownerId || !['sandbox','live'].includes(record.environment)) throw new CommerceError('foreign_commerce_scope', 403); };
      const tx: CommerceTransaction = {
        get,
        list: kind => {requireActive();return (this.db.prepare('SELECT payload FROM commerce_records WHERE deployment=? AND kind=? ORDER BY id').all(this.deploymentId, kind) as { payload: string }[]).map(row => this.decode(kind, row.payload));},
        insert: (kind, record, uniqueKeys = []) => {
          validate(record);
          this.db.prepare('INSERT INTO commerce_records(deployment,kind,id,owner,environment,payload) VALUES(?,?,?,?,?,?)').run(this.deploymentId, kind, record.id, record.ownerId, record.environment, this.encode(kind, record));
          for (const unique of uniqueKeys) this.db.prepare('INSERT INTO commerce_uniques(deployment,kind,key,record_id) VALUES(?,?,?,?)').run(this.deploymentId, kind, unique, record.id);
        },
        put: (kind, record) => {
          validate(record); const prior = get(kind, record.id);
          if (prior && (prior.ownerId !== record.ownerId || prior.environment !== record.environment)) throw new CommerceError('immutable_commerce_scope', 403);
          this.db.prepare('INSERT INTO commerce_records(deployment,kind,id,owner,environment,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(deployment,kind,id) DO UPDATE SET payload=excluded.payload').run(this.deploymentId, kind, record.id, record.ownerId, record.environment, this.encode(kind, record));
        },
        remove: (kind, id) => { requireActive();this.db.prepare('DELETE FROM commerce_records WHERE deployment=? AND kind=? AND id=?').run(this.deploymentId, kind, id); this.db.prepare('DELETE FROM commerce_uniques WHERE deployment=? AND kind=? AND record_id=?').run(this.deploymentId, kind, id); }
      };
      try{return operation(tx);}finally{active=false;}
    });
  }
  private scopeKey(scope: PayPalScope) { if (scope.deploymentId !== this.deploymentId) throw new PayPalError('foreign_deployment'); return JSON.stringify([scope.deploymentId, scope.ownerId, scope.environment]); }
  async withLock<T>(scope: PayPalScope, operation: () => Promise<T>): Promise<T> {
    const key = this.scopeKey(scope), inherited = this.lockContext.getStore();
    if (inherited?.key === key && inherited.valid) return operation();
    const token = randomUUID(), context = { key, token, valid: true }, deadline = Date.now() + 60000;
    for (;;) {
      const acquired = this.atomic(() => {
        this.db.prepare('DELETE FROM commerce_locks WHERE scope=? AND expires<?').run(key, Date.now());
        return this.db.prepare('INSERT OR IGNORE INTO commerce_locks(scope,token,expires) VALUES(?,?,?)').run(key, token, Date.now() + 90000).changes;
      });
      if (acquired) break;
      if (Date.now() > deadline) throw new PayPalError('connection_busy');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const timer = setInterval(() => {
      try { if (!this.db.prepare('UPDATE commerce_locks SET expires=? WHERE scope=? AND token=? AND expires>=?').run(Date.now() + 90000, key, token, Date.now()).changes) context.valid = false; }
      catch { context.valid = false; }
    }, 15000); timer.unref();
    try { return await this.lockContext.run(context, operation); }
    finally { clearInterval(timer); context.valid = false; this.db.prepare('DELETE FROM commerce_locks WHERE scope=? AND token=?').run(key, token); }
  }
  async find(scope: PayPalScope) {
    this.scopeKey(scope);
    const rows = this.db.prepare('SELECT payload FROM commerce_connections WHERE deployment=? AND owner=? AND environment=? AND active=1').all(this.deploymentId, scope.ownerId, scope.environment) as {payload:string}[];
    return rows.length===1?JSON.parse(rows[0].payload) as PayPalConnection:undefined;
  }
  async get(deploymentId: string, id: string) {
    if (deploymentId !== this.deploymentId) return undefined;
    const row = this.db.prepare('SELECT payload FROM commerce_connections WHERE deployment=? AND id=?').get(deploymentId, id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as PayPalConnection : undefined;
  }
  async listConnections(ownerId?: string) {
    return (this.db.prepare('SELECT payload FROM commerce_connections WHERE deployment=?').all(this.deploymentId) as { payload: string }[]).map(row => JSON.parse(row.payload) as PayPalConnection).filter(c => !ownerId || c.ownerId === ownerId);
  }
  async connectionAudits(ownerId: string) {
    return (this.db.prepare('SELECT a.payload FROM commerce_connection_audit a JOIN commerce_connections c ON c.deployment=a.deployment AND c.id=a.connection WHERE a.deployment=? AND c.owner=?').all(this.deploymentId,ownerId) as {payload:string}[]).map(row=>JSON.parse(row.payload) as PayPalConnectionAudit);
  }
  async purgeConnectionAudits(before:string){this.db.prepare("DELETE FROM commerce_connection_audit WHERE deployment=? AND json_extract(payload,'$.at')<?").run(this.deploymentId,before);}
  private assertFence(record: PayPalConnection) {
    const context = this.lockContext.getStore(), scope = this.scopeKey(record);
    if (!context?.valid || context.key !== scope) throw new PayPalError('connection_lock_required');
    const lease = this.db.prepare('SELECT token,expires FROM commerce_locks WHERE scope=?').get(scope) as { token: string; expires: number } | undefined;
    if (lease?.token !== context.token || lease.expires < Date.now()) throw new PayPalError('connection_lock_lost');
  }
  async save(record: PayPalConnection, expectedRevision: number, audit: PayPalConnectionAudit) {
    this.atomic(() => {
      this.assertFence(record);
      if (record.revision !== expectedRevision + 1) throw new PayPalError('connection_revision_conflict');
      if (!expectedRevision) this.db.prepare('INSERT INTO commerce_connections(deployment,id,owner,environment,active,revision,payload) VALUES(?,?,?,?,1,?,?)').run(this.deploymentId, record.id, record.ownerId, record.environment, record.revision, JSON.stringify(record));
      else if (!this.db.prepare('UPDATE commerce_connections SET revision=?,payload=? WHERE deployment=? AND id=? AND owner=? AND environment=? AND revision=?').run(record.revision, JSON.stringify(record), this.deploymentId, record.id, record.ownerId, record.environment, expectedRevision).changes) throw new PayPalError('connection_revision_conflict');
      this.db.prepare('INSERT INTO commerce_connection_audit(id,deployment,connection,payload) VALUES(?,?,?,?)').run(randomUUID(), this.deploymentId, record.id, JSON.stringify(audit));
    });
  }
  async archive(record: PayPalConnection, deadline: string, audit: PayPalConnectionAudit) {
    this.atomic(() => { this.assertFence(record); const next = { ...record, drainingUntil: deadline, acceptsCheckouts: false, revision: record.revision + 1 };
      if (!this.db.prepare('UPDATE commerce_connections SET active=0,revision=?,payload=? WHERE deployment=? AND id=? AND revision=? AND active=1').run(next.revision, JSON.stringify(next), this.deploymentId, record.id, record.revision).changes) throw new PayPalError('connection_revision_conflict');
      this.db.prepare('INSERT INTO commerce_connection_audit(id,deployment,connection,payload) VALUES(?,?,?,?)').run(randomUUID(), this.deploymentId, record.id, JSON.stringify(audit)); });
  }
  async countUnconfirmedOrders(connection: PayPalConnection) {
    return this.transaction(tx => tx.list('checkout').filter(o => o.connectionId === connection.id && (!['completed','failed'].includes(o.state)||(o.billing&&!['CANCELLED','EXPIRED'].includes(o.subscriptionState??'')))).length);
  }
  async acceptEvent(input: Parameters<PayPalConnectionStore['acceptEvent']>[0]): Promise<'accepted' | 'duplicate'> {
    if (input.connection.deploymentId !== this.deploymentId) throw new PayPalError('foreign_deployment');
    return this.transaction(tx => {
      const id = createHash('sha256').update(JSON.stringify([input.connection.id, input.connection.environment, input.eventId])).digest('hex');
      if (tx.get('event', id)) return 'duplicate';
      const receivedAt = new Date(input.receivedAt).toISOString();
      const base = { deploymentId: this.deploymentId, ownerId: input.connection.ownerId, environment: input.connection.environment, id, createdAt: receivedAt, updatedAt: receivedAt };
      tx.insert('event', { ...base, connectionId: input.connection.id, eventId: input.eventId, eventType: input.eventType,
        verification:'verified',attempts:0,payload: Buffer.from(input.rawBody).toString('utf8'), payloadExpiresAt: new Date(Date.parse(input.receivedAt) + 30 * 86400000).toISOString(), state: 'pending' }, [id]);
      tx.insert('job', { ...base, kind: 'event', referenceId: id, state: 'pending', attempts: 0, dueAt: receivedAt }); return 'accepted';
    });
  }
}
