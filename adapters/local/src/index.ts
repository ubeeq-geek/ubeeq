import {removeOwnedLocalVersion} from './owned-version-removal.js';
import type {OwnedVersionRemovalRequest} from '@ubeeq/storage';
import {LocalCustomerIdentities} from './customer-identities.js';
import {LocalUploadStreamCustody} from './upload-stream-custody.js';
import {assertCreatorContentAuthorityChange,compactCreatorContentRepositories,CreatorContentAuthorityError} from '@ubeeq/persistence';
export * from './retained-content-atomic.js';
export { SqliteDirectMessagingStore } from './direct-messaging.js';
export { SqliteCommerceStore } from './commerce.js';
export { SqliteWebsiteStore } from './websites.js';
export * from './website-hosting.js';
import { createCipheriv, createDecipheriv, createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign as signMessage, scryptSync, timingSafeEqual, verify as verifyMessage } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync, realpathSync, openSync, closeSync, fstatSync, constants, createReadStream } from "node:fs";
import { join, resolve, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from 'node:async_hooks';
export { LocalCreatorLibraryStore } from "./creator-library.js";
export { LocalLibraryPublicationView } from './library-publication.js';
export { LocalWorkPublicationLookup, type WorkPublicationScope } from './publication-lookup.js';
export { readCreatorLibrarySnapshot, type CreatorLibrarySnapshot } from './library-export.js';
export { LocalFavoriteStore } from './favorites.js';
export { LocalCreatorFollowStore } from './creator-follows.js';
export { LocalCommentStore } from './comments.js';
import type { AuthenticatedSession, AuthorizationSubject, IdentityAccount, PasswordIdentityAdapter } from "@ubeeq/auth";
import type { DurableJob, JobLease, JobQueue, Scheduler } from "@ubeeq/jobs";
import { JobRecoveryError } from "@ubeeq/jobs";
import type { CredentialVault } from "@ubeeq/integrations";
import type { FederationReplayStore, FederationSignatureVerifier, FederationSigner } from "@ubeeq/federation";
import { RoutingDirectoryConflictError, validateCellRoute, validateMigrationCheckpoint, type CellRoute, type MigrationCheckpoint, type MigrationCheckpointStore, type RoutingDirectory } from "@ubeeq/deployment-platform";
import { CellScopedRepository, OptimisticConcurrencyError, UniqueConstraintError, type CellOwnedRecord, type Page, type PageRequest, type PersistenceTransaction, type RevisionedRecord, type RevisionedRepository, type RepositorySnapshot, type UbeeqRepositories } from "@ubeeq/persistence";
import type { PublicationCommandRepositories } from '@ubeeq/persistence';
import { assertManagedPublicationWrite, assertPublicationDeliveryWrite } from '@ubeeq/persistence';
import { isObjectKeyWithinPrefix, requireCreatorScopedObject, type DeliveryAdapter, type ObjectStorage, type StoredObject, type UploadAcceptance, type UploadContentAdapter, type UploadContentStreamAdapter, type UploadStreamAcceptance, type UploadCompletion, type UploadInitiation, type UploadSealInput, type UploadSealResult } from "@ubeeq/storage";

const now = (): string => new Date().toISOString();
const json = <T>(value: T): string => JSON.stringify(value);
const parse = <T>(value: string): T => JSON.parse(value) as T;
const digest = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
type SqliteDatabase = { close(): void; exec(sql: string): void; prepare(sql: string): { get(...parameters: unknown[]): unknown; all(...parameters: unknown[]): unknown; run(...parameters: unknown[]): { changes: number } }; };
type LocalTransactionState = { id: string; active: boolean; rollbackOnly: boolean; guards: Map<string, number | null>; writes: Set<string> };

export interface LocalAdapterConfiguration { databasePath: string; dataDirectory: string; publicBaseUrl: string; cellId: string; sessionTtlSeconds?: number; credentialEncryptionKey?: string; deliverySigningKey?: string; deliverySigningKeys?: Readonly<Record<string, string>>; activeDeliveryKeyId?: string; }

export class LocalSqliteDatabase {
  readonly database: SqliteDatabase;
  private readonly transactionContext = new AsyncLocalStorage<LocalTransactionState>();
  private owner?: LocalTransactionState;
  private synchronousTransaction=false;
  private transactionTail: Promise<void> = Promise.resolve();

  close(): void { this.database.close(); }

  constructor(readonly configuration: LocalAdapterConfiguration) {
    mkdirSync(resolve(configuration.dataDirectory), { recursive: true });
    mkdirSync(resolve(configuration.databasePath, ".."), { recursive: true });
    const raw = new DatabaseSync(configuration.databasePath) as SqliteDatabase;
    const assertOwner = () => {
      const context = this.transactionContext.getStore();
      if (context && !context.active) throw new Error('SQLite transaction context has ended.');
      if (this.owner && context !== this.owner) throw new Error('SQLite connection is owned by another transaction.');
    };
    // Also guard standalone repository calls and previously prepared statements:
    // they must never join an unrelated transaction or observe uncommitted data.
    this.database = new Proxy(raw, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        assertOwner();
        const result = value.apply(target, args);
        if (property !== 'prepare') return result;
        return new Proxy(result, { get(statement, key) {
          const method = Reflect.get(statement, key, statement);
          return typeof method === 'function' ? (...parameters: unknown[]) => { assertOwner(); return method.apply(statement, parameters); } : method;
        } });
      };
    } });
    // The compact profile has one API process and one worker process. WAL mode
    // keeps readers independent while a bounded busy timeout lets short writes
    // serialize instead of failing immediately under that expected contention.
    this.database.exec("PRAGMA busy_timeout = 5000;");
    // Changing journal mode can return SQLITE_BUSY immediately during simultaneous
    // first opens, even with busy_timeout. Retry only initialization contention.
    const startupDeadline=Date.now()+5000;
    for(;;){try{this.database.exec("PRAGMA journal_mode = WAL;");break;}catch(error){
      if(!/database is locked|database is busy/i.test((error as Error).message)||Date.now()>=startupDeadline)throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
    }}
    this.database.exec("CREATE TABLE IF NOT EXISTS ubeeq_schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    if (!configuration.cellId.trim()) throw new Error("Local adapters require a cellId.");
    this.transactionSync(()=>{
    for (const id of ["001-initial", "002-credential-vault", "003-federation-replays", "004-federation-keys", "005-regional-cell", "006-cell-boundaries", "007-routing-directory", "008-creator-library", "009-creator-handles", "010-creator-handle-history", "011-favorites", "012-creator-follows", "013-comments", "014-comment-visible-pages", "015-creator-asset-lookup", "016-work-publications", "017-source-file-catalogue", "018-job-cell-idempotency", "019-repository-snapshots", "020-account-authorization", "021-customer-identities", "022-upload-stream-custody", "023-customer-password-effects"]) {
      const applied = this.database.prepare("SELECT id FROM ubeeq_schema_migrations WHERE id = ?").get(id) as { id?: string } | undefined;
      if (!applied?.id) { this.database.exec(readFileSync(join(__dirname, "migrations", `${id}.sql`), "utf8")); this.database.prepare("INSERT INTO ubeeq_schema_migrations (id, applied_at) VALUES (?, ?)").run(id, now()); }
    }
    });
  }

  /** Atomic synchronous work must not yield while holding SQLite's write lock. */
  assertTransaction(transaction: PersistenceTransaction): void {
    const context = this.transactionContext.getStore();
    if (!context?.active || context !== this.owner || context.id !== transaction.id) throw new Error('Transaction handle is not active on this repository context.');
  }
  failTransaction(): void {
    const context = this.transactionContext.getStore();
    if (context?.active) context.rollbackOnly = true;
  }
  guardRecord(repository: string, id: string, expected: number | null, transaction: PersistenceTransaction): boolean {
    try{this.assertTransaction(transaction);}catch(error){this.failTransaction();throw error;}
    const context=this.transactionContext.getStore()!,key=JSON.stringify([repository,id]);
    if(context.writes.has(key)){context.rollbackOnly=true;throw new Error('A transaction must guard or write each item once.');}
    if(context.guards.has(key)){
      if(context.guards.get(key)!==expected){context.rollbackOnly=true;throw new OptimisticConcurrencyError(id,expected??0);}
      return false;
    }
    context.guards.set(key,expected);return true;
  }
  recordWrite(repository: string, id: string): void {
    const context=this.transactionContext.getStore();
    if(!context)return;
    this.assertTransaction(context);
    const key=JSON.stringify([repository,id]);
    if(context.guards.has(key)){context.rollbackOnly=true;throw new Error('A transaction cannot write a guarded item.');}
    context.writes.add(key);
  }
  /** Physical provider effects cannot borrow a domain/Raw transaction whose
   * rollback could erase their permanent custody/removal fence. */
  assertOutsideProviderTransaction():void {
    if(this.transactionContext.getStore()||this.owner||this.synchronousTransaction)throw new Error('Physical provider effects must run outside an active Local transaction.');
  }
  transactionSync<T>(operation: () => T): T {
    const inherited = this.transactionContext.getStore();
    if (inherited) {
      if (!inherited.active || this.owner !== inherited) throw new Error('SQLite transaction context has ended.');
      try { return operation(); }
      catch (error) { inherited.rollbackOnly = true; throw error; }
    }
    if (this.owner||this.synchronousTransaction) throw new Error('SQLite connection is owned by another transaction.');
    this.database.exec('BEGIN IMMEDIATE');this.synchronousTransaction=true;
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    finally{this.synchronousTransaction=false;}
  }

  async transaction<T>(operation: (transaction: PersistenceTransaction) => Promise<T>): Promise<T> {
    const inherited = this.transactionContext.getStore();
    if (inherited) {
      if (!inherited.active || this.owner !== inherited) throw new Error('SQLite transaction context has ended.');
      try { return await operation({ id: inherited.id }); }
      catch (error) { inherited.rollbackOnly = true; throw error; }
    }
    let release!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const context:LocalTransactionState = { id: `sqlite-${randomUUID()}`, active: true, rollbackOnly: false, guards:new Map(), writes:new Set() };
    this.owner = context;
    try {
      return await this.transactionContext.run(context, async () => {
        this.database.exec('BEGIN IMMEDIATE');
        try {
          const result = await operation({ id: context.id });
          if (context.rollbackOnly) throw new Error('SQLite transaction is rollback-only after a nested failure.');
          this.database.exec('COMMIT');
          return result;
        } catch (error) { this.database.exec('ROLLBACK'); throw error; }
      });
    } finally { context.active = false; this.owner = undefined; release(); }
  }
}

class SqliteRevisionedRepository<T extends RevisionedRecord> implements RevisionedRepository<T> {
  constructor(private readonly local: LocalSqliteDatabase, private readonly repository: string) {}
  private guard(previous:T|undefined,next:T|undefined){
    try {
      if(this.repository==='creators')assertCreatorContentAuthorityChange(previous as unknown as import('@ubeeq/persistence').CreatorRecord|undefined,next as unknown as import('@ubeeq/persistence').CreatorRecord|undefined);
      if((compactCreatorContentRepositories as readonly string[]).includes(this.repository)){
        const read=(repository:string,id:string)=>{const row=this.local.database.prepare('SELECT payload FROM ubeeq_records WHERE repository = ? AND id = ?').get(repository,id) as {payload:string}|undefined;return row?JSON.parse(row.payload):undefined;};
        for(const value of [previous,next] as Array<Record<string,any>|undefined>){
          if(!value)continue;const creatorId=value.creatorId??(value.workId?read('works',value.workId)?.creatorId:undefined)??(value.collectionId?read('collections',value.collectionId)?.creatorId:undefined);
          if(creatorId&&read('creators',creatorId)?.contentAuthority==='retained-v1')throw new CreatorContentAuthorityError();
        }
      }
      if (next && this.repository === 'publications') assertManagedPublicationWrite(previous as unknown as import('@ubeeq/persistence').ManagedPublicationRecord, next as unknown as import('@ubeeq/persistence').ManagedPublicationRecord);
      if (next && this.repository === 'publicationOperations') assertPublicationDeliveryWrite(previous as unknown as import('@ubeeq/persistence').PublicationDeliveryRecord, next as unknown as import('@ubeeq/persistence').PublicationDeliveryRecord);
    } catch (error) { this.local.failTransaction(); throw error; }
  }

  private write(operation: () => { changes: number }): { changes: number } {
    try { return operation(); }
    catch (error) {
      if (this.repository === 'creators' && error instanceof Error && (error.message.includes("UNIQUE constraint failed: index 'ubeeq_creator_current_handle'") || error.message.includes('UNIQUE constraint failed: ubeeq_creator_handle_aliases.instance_id, ubeeq_creator_handle_aliases.handle'))) {
        throw new UniqueConstraintError({ name: 'creator_current_handle', values: {} });
      }
      throw error;
    }
  }

  private retainHandleHistory(value: T, previous?: T): T {
    if (this.repository !== 'creators') return value;
    const next = value as T & { instanceId?: string; handle?: string; handleHistory?: readonly string[] };
    const old = previous as typeof next | undefined;
    if (old && next.instanceId !== old.instanceId) throw new Error('Creator instance is immutable outside migration.');
    for (const history of [old?.handleHistory, next.handleHistory]) {
      if (history !== undefined && (!Array.isArray(history) || history.some(item => typeof item !== 'string' || !item))) throw new Error('Creator handle history is invalid.');
    }
    if (typeof next.handle !== 'string') return value;
    return { ...value, handleHistory: [...new Set([...(old?.handleHistory || []), ...(old?.handle ? [old.handle] : []), ...(next.handleHistory || []), next.handle])] };
  }

  async create(record: Omit<T, "revision" | "createdAt" | "updatedAt">, options?: { idempotencyKey?: string; transaction?:PersistenceTransaction }): Promise<T> {
    if(options?.transaction)this.local.assertTransaction(options.transaction);
    return this.local.transactionSync(() => {
      if (options?.idempotencyKey) {
        const existing = this.local.database.prepare("SELECT record_id FROM ubeeq_idempotency WHERE repository = ? AND idempotency_key = ?").get(this.repository, options.idempotencyKey) as { record_id?: string } | undefined;
        if (existing?.record_id) return this.read(existing.record_id)!;
      }
      this.local.recordWrite(this.repository,record.id);
      const existing = this.read(record.id);
      if (existing) throw new Error(`Record ${record.id} already exists.`);
      const timestamp = now();
      const value = this.retainHandleHistory({ ...record, revision: 1, createdAt: timestamp, updatedAt: timestamp } as T);
      this.guard(undefined, value);
      this.write(() => this.local.database.prepare("INSERT INTO ubeeq_records (repository, id, revision, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(this.repository, value.id, value.revision, json(value), timestamp, timestamp));
      if (options?.idempotencyKey) this.local.database.prepare("INSERT INTO ubeeq_idempotency (repository, idempotency_key, record_id, created_at) VALUES (?, ?, ?, ?)").run(this.repository, options.idempotencyKey, value.id, timestamp);
      return value;
    });
  }

  async get(id: string): Promise<T | undefined> {
    return this.read(id);
  }
  async checkRevision(id: string, expectedRevision: number, _options: { transaction: PersistenceTransaction }): Promise<void> {
    if(!this.local.guardRecord(this.repository,id,expectedRevision,_options.transaction))return;
    // The transaction owns BEGIN IMMEDIATE; this read stays guarded until commit.
    const current = this.read(id);
    if (!current || current.revision !== expectedRevision) { this.local.failTransaction(); throw new OptimisticConcurrencyError(id, expectedRevision); }
  }
  async checkAbsent(id: string, options: { transaction: PersistenceTransaction }): Promise<void> {
    if(!this.local.guardRecord(this.repository,id,null,options.transaction))return;
    // BEGIN IMMEDIATE excludes every other SQLite writer until this commit.
    if(this.read(id)){this.local.failTransaction();throw new OptimisticConcurrencyError(id,0);}
  }

  private read(id: string): T | undefined {
    const row = this.local.database.prepare("SELECT payload FROM ubeeq_records WHERE repository = ? AND id = ?").get(this.repository, id) as { payload?: string } | undefined;
    return row?.payload ? parse<T>(row.payload) : undefined;
  }

  async list(request: PageRequest): Promise<Page<T>> {
    const limit = Math.max(1, Math.min(100, request.limit));
    const after = request.cursor ? Buffer.from(request.cursor, "base64url").toString("utf8") : "";
    const rows = this.local.database.prepare("SELECT payload, id FROM ubeeq_records WHERE repository = ? AND id > ? ORDER BY id LIMIT ?").all(this.repository, after, limit + 1) as Array<{ payload: string; id: string }>;
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(({ payload }) => parse<T>(payload));
    return { items, nextCursor: hasMore ? Buffer.from(items.at(-1)!.id).toString("base64url") : undefined };
  }

  async snapshot(): Promise<RepositorySnapshot<T>> {
    return this.local.transaction(async () => {
      const version = () => {
        const value = (this.local.database.prepare('SELECT version FROM ubeeq_repository_versions WHERE repository = ?').get(this.repository) as {version:number}|undefined)?.version ?? 0;
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Repository change marker requires reconciliation.');
        return value;
      };
      const expected = version();
      // One canonical table read includes legacy rows; zero is a mutation marker,
      // never a claim that the inventory or publication history is empty.
      const rows = this.local.database.prepare('SELECT payload FROM ubeeq_records WHERE repository = ? ORDER BY id').all(this.repository) as Array<{payload:string}>;
      return {items:rows.map(row=>parse<T>(row.payload)),bind:async transaction=>{
        this.local.assertTransaction(transaction);
        if (version() !== expected) { this.local.failTransaction(); throw new OptimisticConcurrencyError('repository:'+this.repository, expected); }
      }};
    });
  }

  async update(id:string,expectedRevision:number,change:Partial<Omit<T,'id'|'revision'|'createdAt'|'updatedAt'>>,options?:{transaction?:PersistenceTransaction}):Promise<T>{
    if(options?.transaction)this.local.assertTransaction(options.transaction);
    return this.local.transactionSync(()=>{
      this.local.recordWrite(this.repository,id);
      const current=this.read(id);
      if(!current||current.revision!==expectedRevision){this.local.failTransaction();throw new OptimisticConcurrencyError(id,expectedRevision);}
      const value=this.retainHandleHistory({...current,...change,revision:current.revision+1,updatedAt:now()} as T,current);
      this.guard(current,value);
      const result=this.write(()=>this.local.database.prepare('UPDATE ubeeq_records SET revision = ?, payload = ?, updated_at = ? WHERE repository = ? AND id = ? AND revision = ?').run(value.revision,json(value),value.updatedAt,this.repository,id,expectedRevision));
      if(result.changes!==1)throw new OptimisticConcurrencyError(id,expectedRevision);
      return value;
    });
  }
  async remove(id:string,expectedRevision:number,options?:{transaction?:PersistenceTransaction}):Promise<void>{
    if(options?.transaction)this.local.assertTransaction(options.transaction);
    this.local.transactionSync(()=>{
      this.local.recordWrite(this.repository,id);
      this.guard(this.read(id),undefined);
      const result=this.local.database.prepare('DELETE FROM ubeeq_records WHERE repository = ? AND id = ? AND revision = ?').run(this.repository,id,expectedRevision);
      if(result.changes!==1)throw new OptimisticConcurrencyError(id,expectedRevision);
    });
  }
}

const repository = <T extends RevisionedRecord>(local: LocalSqliteDatabase, name: string): RevisionedRepository<T> => new SqliteRevisionedRepository<T>(local, name);
const cellRepository = <T extends RevisionedRecord & CellOwnedRecord>(local: LocalSqliteDatabase, name: string): RevisionedRepository<T> => new CellScopedRepository(repository<T>(local, name), local.configuration.cellId);

/** Shares the authoritative publications/works buckets and SQLite transaction with the ordinary repositories. */
export const createLocalPublicationCommandRepositories = (local: LocalSqliteDatabase): PublicationCommandRepositories & UbeeqRepositories => ({
  ...createLocalRepositories(local), publications: cellRepository(local, 'publications'),
  claims: cellRepository(local, 'publicationClaims'), operations: cellRepository(local, 'publicationOperations'),
  outbox: cellRepository(local, 'publicationOutbox'), auditEvents: cellRepository(local, 'auditEvents')
});

/** Durable local composition. It is intentionally a generic JSON-record adapter, not an in-memory default. */
export const createLocalRepositories = (local: LocalSqliteDatabase): UbeeqRepositories => ({
  transaction: local.transaction.bind(local),
  readScope:operation=>local.transaction(transaction=>operation(transaction)),
  hostRecords: cellRepository(local, "hostRecords"),
  creators: cellRepository(local, "creators"), works: cellRepository(local, "works"), assets: cellRepository(local, "assets"), collections: cellRepository(local, "collections"), workMemberships: cellRepository(local, "workMemberships"),
  publicationIntents: cellRepository(local, "publicationIntents"), publications: cellRepository(local, "publications"), reconciliationSnapshots: cellRepository(local, "reconciliationSnapshots"),
  moderationEvidence: cellRepository(local, "moderationEvidence"), moderationHolds: cellRepository(local, "moderationHolds"), reviewCases: cellRepository(local, "reviewCases"), auditEvents: cellRepository(local, "auditEvents"),
  usageEvents: cellRepository(local, "usageEvents"), creditLots: cellRepository(local, "creditLots"), creditReservations: cellRepository(local, "creditReservations"), balances: cellRepository(local, "balances"),
  integrationAccounts: cellRepository(local, "integrationAccounts"), syncCursors: cellRepository(local, "syncCursors"), integrationJobs: cellRepository(local, "integrationJobs"), exportManifests: cellRepository(local, "exportManifests"), importCheckpoints: cellRepository(local, "importCheckpoints"), instanceOperators: repository(local, "instanceOperators"), federationActors: repository(local, "federationActors"), remotePublicationReferences: repository(local, "remotePublicationReferences")
});

export class LocalFilesystemStorage implements ObjectStorage, UploadContentAdapter, UploadContentStreamAdapter, DeliveryAdapter {
  removeOwnedVersion(input:OwnedVersionRemovalRequest){return removeOwnedLocalVersion(this.local,input);}
  private readonly uploadCustody:LocalUploadStreamCustody;
  constructor(private readonly local: LocalSqliteDatabase) {
    this.local.database.exec("CREATE TABLE IF NOT EXISTS ubeeq_upload_completions (id TEXT PRIMARY KEY, cell_id TEXT NOT NULL, creator_id TEXT NOT NULL, object_payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','completed')))");
    this.local.database.exec('CREATE TABLE IF NOT EXISTS ubeeq_upload_seals (id TEXT PRIMARY KEY, cell_id TEXT NOT NULL, creator_id TEXT NOT NULL, proof_id TEXT NOT NULL, closed_at TEXT NOT NULL)');
    this.uploadCustody=new LocalUploadStreamCustody(local);
  }
  private sameUploadObject(a:StoredObject,b:StoredObject):boolean {
    const facts=(o:StoredObject)=>[o.bucket,o.key,o.versionId??null,o.contentType,o.byteLength,o.checksum??null,o.scope];
    return json(facts(a))===json(facts(b));
  }
  private objectPath(object: Pick<StoredObject, "bucket" | "key" | "versionId">): string {
    const root = resolve(this.local.configuration.dataDirectory, "objects", object.bucket);
    const path = resolve(root, object.key, object.versionId ?? "current");
    if (relative(root, path).startsWith("..")) throw new Error("Object key escapes local storage root.");
    return path;
  }
  async put(input: { object: StoredObject; body: Uint8Array }): Promise<void> {
    const path = this.objectPath(input.object); mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, input.body); writeFileSync(`${path}.json`, json(input.object));
  }
  /** Private transfer writer; authorization remains the transfer caller's duty. */
  async writePrivateVersion(input: { object: Omit<StoredObject, "versionId">; body: Uint8Array }): Promise<StoredObject> {
    const object: StoredObject = { ...structuredClone(input.object), versionId: randomUUID() };
    const body = Uint8Array.from(input.body);
    const match = object.key.match(/^cells\/([^/]+)\/creators\/([^/]+)\//);
    if (!match || match[1] !== this.local.configuration.cellId || object.bucket !== this.local.configuration.cellId ||
      object.scope !== "private" || !object.contentType || !body.byteLength ||
      object.byteLength !== body.byteLength || object.checksum !== digest(body)) throw new Error("Invalid private transfer object.");
    if (!isObjectKeyWithinPrefix(object.key, `cells/${match[1]}/creators/${match[2]}`)) throw new Error("Invalid private transfer key.");
    const path = this.objectPath(object);
    mkdirSync(resolve(path, ".."), { recursive: true });
    // The local provider owns this physical version; never overwrite one.
    writeFileSync(path, body, { flag: "wx", mode: 0o600 });
    writeFileSync(`${path}.json`, json(object), { flag: "wx", mode: 0o600 });
    return object;
  }
  async get(input: Pick<StoredObject, "bucket" | "key" | "versionId">): Promise<{ object: StoredObject; body: Uint8Array }> {
    const path = this.objectPath(input); return { object: parse<StoredObject>(readFileSync(`${path}.json`, "utf8")), body: readFileSync(path) };
  }
  async openReadStream(input:Pick<StoredObject,'bucket'|'key'>&{versionId:string}){
    if(!input.bucket||Buffer.byteLength(input.bucket)>255||/[\\/\r\n\u0000]/.test(input.bucket)||['.','..'].includes(input.bucket)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.versionId??''))throw Error('An exact local object bucket/version is required.');
    const match=input.key.match(/^cells\/([^/]+)\/creators\/([^/]+)\//);if(!match||match[1]!==this.local.configuration.cellId)throw Error('Original stream is outside its cell.');
    requireCreatorScopedObject(input.key,{cellId:match[1],creatorId:match[2]});
    const root=realpathSync(resolve(this.local.configuration.dataDirectory,'objects',input.bucket)),path=resolve(root,input.key,input.versionId);
    if(!path.startsWith(root+'/')||realpathSync(path)!==path||realpathSync(path+'.json')!==path+'.json')throw Error('Original stream location escapes its owned root.');
    let fd:number|undefined;
    try{
      if(statSync(path+'.json').size>64*1024)throw Error('Original stream metadata exceeds its safe size.');
      const object=parse<StoredObject>(readFileSync(path+'.json','utf8'));
      fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const observed=fstatSync(fd);
      if(!observed.isFile()||object.bucket!==input.bucket||object.key!==input.key||object.versionId!==input.versionId||object.byteLength!==observed.size||!Number.isSafeInteger(object.byteLength)||!object.contentType||!['private','restricted','public'].includes(object.scope))throw Error('Original stream metadata conflicts.');
      const body=createReadStream(path,{fd,autoClose:true,highWaterMark:64*1024});fd=undefined;
      return {object,body,async close(){body.destroy();}};
    }finally{if(fd!==undefined)closeSync(fd);}
  }
  async remove(input: Pick<StoredObject, "bucket" | "key" | "versionId">): Promise<void> { const path = this.objectPath(input); rmSync(path, { force: true }); rmSync(`${path}.json`, { force: true }); }
  async initiate(input: { object: StoredObject; checksumAlgorithm: "sha256"; multipart?: boolean; expiresAt: string; idempotencyKey?: string }): Promise<UploadInitiation> {
    const match = input.object.key.match(/^cells\/([^/]+)\/creators\/([^/]+)\//); if (!match) throw new Error("Upload object is not creator-scoped.");
    const uploadId = input.idempotencyKey ? digest(JSON.stringify([match[1],input.object.key,input.idempotencyKey])) : randomUUID();
    if(this.local.database.prepare('SELECT id FROM ubeeq_upload_seals WHERE id=?').get(uploadId))throw new Error('Upload is permanently sealed.');
    if(this.local.database.prepare("SELECT id FROM ubeeq_upload_completions WHERE id=?").get(uploadId)) throw new Error("Upload operation already has a completion intent.");
    this.local.database.prepare("INSERT OR IGNORE INTO ubeeq_uploads (id, object_payload, cell_id, creator_id, expires_at, expected_checksum, expected_byte_length, operation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(uploadId, json(input.object), match[1], match[2], input.expiresAt, input.object.checksum ?? null, input.object.byteLength, "upload_content", now());
    const saved = this.local.database.prepare("SELECT object_payload, expires_at FROM ubeeq_uploads WHERE id=?").get(uploadId) as {object_payload:string;expires_at:string};
    if(!this.sameUploadObject(parse<StoredObject>(saved.object_payload),input.object) || saved.expires_at !== input.expiresAt) throw new Error("Upload initiation idempotency conflict.");
    return { uploadId, object: input.object, completeUrl: `${this.local.configuration.publicBaseUrl.replace(/\/$/, "")}/v1/uploads/${uploadId}/complete`, expiresAt: input.expiresAt };
  }
  async accept(input:UploadAcceptance):Promise<void>{
    // Byte callers share the same custody/receipt path; new content is never
    // duplicated into SQLite BLOBs. The exact stream verifier remains mandatory.
    await this.acceptStream({...input,body:(async function*(){yield input.body;})()});
  }
  async acceptStream(input:UploadStreamAcceptance):Promise<void>{return this.uploadCustody.acceptStream(input);}
  async abort(input:{uploadId:string;cellId:string;creatorId:string}):Promise<void>{return this.uploadCustody.abort(input);}
  async complete(input:UploadCompletion):Promise<StoredObject>{return this.uploadCustody.complete(input);}
  async recoverCompletion(input:UploadCompletion):Promise<StoredObject|undefined>{return this.uploadCustody.recoverCompletion(input);}
  async seal(input:UploadSealInput):Promise<UploadSealResult>{return this.uploadCustody.seal(input);}
  async issue(request: { object: Pick<StoredObject, "bucket" | "key" | "versionId" | "scope">; expiresAt: string; disposition?: "inline" | "attachment" }): Promise<{ url: string; expiresAt: string }> {
    const match = request.object.key.match(/^cells\/([^/]+)\/creators\/([^/]+)\//); if (!match || match[1] !== this.local.configuration.cellId) throw new Error("Delivery object is not scoped to this cell.");
    if (request.object.scope === "public" && !request.object.key.includes("/renditions/")) throw new Error("Only rendition objects may receive public cacheable delivery tokens.");
    if (Date.parse(request.expiresAt) <= Date.now()) throw new Error("Delivery expiry must be in the future.");
    const keyId = this.local.configuration.activeDeliveryKeyId ?? "local-v1"; const payload = Buffer.from(json({ version: 1, keyId, cellId: match[1], creatorId: match[2], ...request.object, disposition: request.disposition ?? "inline", expiresAt: request.expiresAt })).toString("base64url"); const signature = createHmac("sha256", this.deliveryKey(keyId)).update(payload).digest("base64url"); return { url: `${this.local.configuration.publicBaseUrl.replace(/\/$/, "")}/v1/delivery/${payload}.${signature}`, expiresAt: request.expiresAt };
  }
  verifyDeliveryToken(token: string): { version: 1; keyId: string; cellId: string; creatorId: string; bucket: string; key: string; versionId?: string; scope: StoredObject["scope"]; disposition: "inline" | "attachment"; expiresAt: string } { const [payload, signature, extra] = token.split("."); if (!payload || !signature || extra) throw new Error("Delivery token is malformed."); let claims: ReturnType<LocalFilesystemStorage["verifyDeliveryToken"]>; try { claims = parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new Error("Delivery token claims are malformed."); } const expected = createHmac("sha256", this.deliveryKey(claims.keyId)).update(payload).digest(); const supplied = Buffer.from(signature, "base64url"); if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("Delivery token signature is invalid."); if (claims.version !== 1 || claims.cellId !== this.local.configuration.cellId || Date.parse(claims.expiresAt) <= Date.now()) throw new Error("Delivery token is expired or belongs to another cell."); requireCreatorScopedObject(claims.key, claims); if (claims.bucket !== claims.cellId || (claims.scope === "public" && !claims.key.includes("/renditions/"))) throw new Error("Delivery claims violate cell cache policy."); return claims; }
  private deliveryKey(keyId: string): Buffer { const configured = this.local.configuration.deliverySigningKeys?.[keyId] ?? (keyId === (this.local.configuration.activeDeliveryKeyId ?? "local-v1") ? this.local.configuration.deliverySigningKey : undefined); if (!configured && this.local.configuration.deliverySigningKeys) throw new Error("Delivery token keyId is unknown."); return createHash("sha256").update(configured ?? this.local.configuration.credentialEncryptionKey ?? `local-delivery:${resolve(this.local.configuration.databasePath)}`).digest(); }
}

export class LocalIdentityAdapter implements PasswordIdentityAdapter {
  readonly customerAccounts:LocalCustomerIdentities;
  constructor(private readonly local: LocalSqliteDatabase) {this.customerAccounts=new LocalCustomerIdentities(local);}
  async register(input: { email: string; password: string }): Promise<IdentityAccount> {
    if (!/^\S+@\S+\.\S+$/.test(input.email) || input.password.length < 12) throw new Error("Local accounts require a valid email and a password of at least 12 characters.");
    const id = randomUUID(), timestamp = now(), salt = randomBytes(16).toString("hex"), passwordHash = scryptSync(input.password, salt, 64).toString("hex");
    this.local.database.prepare("INSERT INTO ubeeq_accounts (id, email, password_hash, salt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.email.toLowerCase(), passwordHash, salt, "active", timestamp, timestamp);
    return { id, subjectId: id, status: "active", createdAt: timestamp, updatedAt: timestamp };
  }
  async authenticate(input: { email: string; password: string }): Promise<{ token: string; session: AuthenticatedSession }> {
    const read=()=>this.local.database.prepare("SELECT id,email,password_hash,salt,status,account_scope,roles_json,scopes_json,email_verified,customer_password_state FROM ubeeq_accounts WHERE email = ?").get(input.email.toLowerCase()) as {id:string;email:string;password_hash:string;salt:string;status:string;account_scope:string;roles_json:string;scopes_json:string;email_verified:number;customer_password_state:string}|undefined;
    const row=read();
    if (!row || row.status !== "active" || row.customer_password_state!=="set") throw new Error("Invalid local credentials.");
    const supplied = scryptSync(input.password, row.salt, 64); const expected = Buffer.from(row.password_hash, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("Invalid local credentials.");
    return this.local.transaction(async()=>{
      const current=read();
      if(!current||!Object.keys(row).every(key=>row[key as keyof typeof row]===current[key as keyof typeof current]))throw new Error("Invalid local credentials.");
      const subject=await this.getAuthorizationSubject(row.id);
      if(!subject||subject.accountScope!==row.account_scope)throw new Error("Invalid local credentials.");
      const token = randomBytes(32).toString("base64url"), id = randomUUID(), timestamp = now(), expiresAt = new Date(Date.now() + (this.local.configuration.sessionTtlSeconds ?? 86_400) * 1000).toISOString();
      this.local.database.prepare("INSERT INTO ubeeq_sessions (id, account_id, token_hash, expires_at, created_at, account_scope_at_issue) VALUES (?, ?, ?, ?, ?, ?)").run(id, row.id, digest(token), expiresAt, timestamp, subject.accountScope);
      return { token, session: { id, subject, issuedAt: timestamp, expiresAt, authenticationMethod: "password" as const } };
    });
  }
  async verifySession(input: { credential: string }): Promise<AuthenticatedSession | undefined> {
    const row = this.local.database.prepare("SELECT s.id, s.account_id, s.expires_at, s.account_scope_at_issue FROM ubeeq_sessions s WHERE s.token_hash = ? AND s.revoked_at IS NULL").get(digest(input.credential)) as { id: string; account_id: string; expires_at: string; account_scope_at_issue:string } | undefined;
    if (!row || row.expires_at <= now()) return undefined;
    const subject = await this.getAuthorizationSubject(row.account_id);
    if (!subject || subject.accountScope!==row.account_scope_at_issue) return undefined;
    return { id: row.id, subject, issuedAt: "", expiresAt: row.expires_at, authenticationMethod: "password" };
  }
  async withVerifiedSession<T>(input:{credential:string;audience?:string},operation:(session:AuthenticatedSession,transaction:import('@ubeeq/auth').CustomerIdentityTransaction)=>Promise<T>):Promise<T|undefined>{
    return this.local.transaction(async transaction=>{
      const session=await this.verifySession(input);if(!session)return undefined;
      return operation(session,transaction);
    });
  }
  async getAccount(subjectId: string): Promise<IdentityAccount | undefined> { const row = this.local.database.prepare("SELECT id, status, created_at, updated_at FROM ubeeq_accounts WHERE id = ?").get(subjectId) as { id: string; status: IdentityAccount["status"]; created_at: string; updated_at: string } | undefined; return row ? { id: row.id, subjectId: row.id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at } : undefined; }
  async getAuthorizationSubject(subjectId: string): Promise<AuthorizationSubject | undefined> {
    const row = this.local.database.prepare('SELECT id, email, status, account_scope, roles_json, scopes_json, email_verified FROM ubeeq_accounts WHERE id = ?').get(subjectId) as { id: string; email: string; status: string; account_scope: string; roles_json: string; scopes_json: string; email_verified:number } | undefined;
    if (!row || row.status !== 'active') return undefined;
    if (row.id !== subjectId || !['creator_operator', 'customer_account'].includes(row.account_scope)) throw new Error('Local authorization evidence is unavailable.');
    const values = (encoded: string): string[] => {
      let result: unknown;
      try { result = JSON.parse(encoded); } catch { throw new Error('Local authorization evidence is unavailable.'); }
      if (!Array.isArray(result) || result.some(value => typeof value !== 'string' || !value)) throw new Error('Local authorization evidence is unavailable.');
      return result;
    };
    return { id: row.id, email: row.email, ...(row.email_verified===1?{emailVerified:true}:{}), accountScope: row.account_scope as AuthorizationSubject['accountScope'], roles: values(row.roles_json), scopes: values(row.scopes_json) };
  }
  async listDelegations(): Promise<readonly []> { return []; }
  async revokeSession(input: { sessionId: string }): Promise<void> {
    // Independent sign-out joins the real writer queue; it never fails merely
    // because another accepting Local operation currently owns this connection.
    await this.local.transaction(async()=>{this.local.database.prepare("UPDATE ubeeq_sessions SET revoked_at = ? WHERE id = ?").run(now(), input.sessionId);});
  }
}

/** Development-only encrypted credential custody. Production adapters must use a managed vault/key boundary. */
export class LocalCredentialVault implements CredentialVault {
  private readonly key: Buffer;
  constructor(private readonly local: LocalSqliteDatabase) { this.key = createHash("sha256").update(local.configuration.credentialEncryptionKey ?? `local-development:${resolve(local.configuration.databasePath)}`).digest(); }
  async write(input: { cellId: string; ownerId: string; value: Uint8Array; expiresAt?: string }): Promise<{ reference: string }> {
    if (input.cellId !== this.local.configuration.cellId) throw new Error("Credential belongs to another cell.");
    const id = randomUUID(), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv); const ciphertext = Buffer.concat([cipher.update(input.value), cipher.final()]), tag = cipher.getAuthTag();
    this.local.database.prepare("INSERT INTO ubeeq_credentials (id, cell_id, owner_id, ciphertext, iv, auth_tag, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.cellId, input.ownerId, ciphertext, iv, tag, input.expiresAt ?? null, now()); return { reference: `local-vault:${input.cellId}:${id}` };
  }
  async read(input: { cellId: string; reference: string }): Promise<Uint8Array | undefined> {
    const prefix = `local-vault:${input.cellId}:`; if (!input.reference.startsWith(prefix) || input.cellId !== this.local.configuration.cellId) return undefined; const id = input.reference.slice(prefix.length);
    const row = this.local.database.prepare("SELECT ciphertext, iv, auth_tag, expires_at, revoked_at FROM ubeeq_credentials WHERE id = ? AND cell_id = ?").get(id, input.cellId) as { ciphertext: Uint8Array; iv: Uint8Array; auth_tag: Uint8Array; expires_at?: string; revoked_at?: string } | undefined;
    if (!row || row.revoked_at || (row.expires_at && row.expires_at <= now())) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", this.key, row.iv); decipher.setAuthTag(Buffer.from(row.auth_tag)); return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
  }
  async revoke(input: { cellId: string; reference: string }): Promise<void> { const prefix = `local-vault:${input.cellId}:`; if (input.reference.startsWith(prefix) && input.cellId === this.local.configuration.cellId) this.local.database.prepare("UPDATE ubeeq_credentials SET revoked_at = ? WHERE id = ? AND cell_id = ?").run(now(), input.reference.slice(prefix.length), input.cellId); }
  async pruneCommerceOrphans(referenced: readonly string[], createdBefore: string): Promise<void> {
    const rows=this.local.database.prepare("SELECT id FROM ubeeq_credentials WHERE cell_id=? AND owner_id LIKE 'paypal-commerce:%' AND revoked_at IS NULL AND created_at<?").all(this.local.configuration.cellId,createdBefore) as {id:string}[];
    const keep=new Set(referenced);
    for(const row of rows){const reference=`local-vault:${this.local.configuration.cellId}:${row.id}`;if(!keep.has(reference))await this.revoke({cellId:this.local.configuration.cellId,reference});}
  }
}

/** Local Ed25519 signing is a portable reference; hosted instances may resolve keys from a managed provider. */
export class LocalFederationKey implements FederationSigner, FederationSignatureVerifier, FederationReplayStore {
  readonly keyId = "local-ed25519-v1"; readonly publicKey: string; private readonly privateKey: string;
  constructor(private readonly local: LocalSqliteDatabase) {
    const existing = local.database.prepare("SELECT private_key, public_key FROM ubeeq_federation_keys WHERE id = ?").get(this.keyId) as { private_key?: string; public_key?: string } | undefined;
    if (existing?.private_key && existing.public_key) { this.privateKey = existing.private_key; this.publicKey = existing.public_key; }
    else { const pair = generateKeyPairSync("ed25519"); this.privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(); this.publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString(); local.database.prepare("INSERT INTO ubeeq_federation_keys (id, private_key, public_key, created_at) VALUES (?, ?, ?, ?)").run(this.keyId, this.privateKey, this.publicKey, now()); }
  }
  async sign(message: string): Promise<string> { return signMessage(null, Buffer.from(message), this.privateKey).toString("base64url"); }
  async verify(input: { keyId: string; message: string; signature: string }): Promise<boolean> { return input.keyId === this.keyId && verifyMessage(null, Buffer.from(input.message), this.publicKey, Buffer.from(input.signature, "base64url")); }
  async consume(input: { envelopeId: string; expiresAt: string }): Promise<boolean> { const result = this.local.database.prepare("INSERT OR IGNORE INTO ubeeq_federation_replays (id, expires_at, created_at) VALUES (?, ?, ?)").run(input.envelopeId, input.expiresAt, now()); return result.changes === 1; }
}

export class LocalSqliteJobQueue implements JobQueue, Scheduler {
  constructor(private readonly local: LocalSqliteDatabase) {}
  async enqueue<T>(input: Omit<DurableJob<T>, "id" | "state" | "attempt" | "availableAt" | "createdAt" | "updatedAt"> & { availableAt?: string }): Promise<DurableJob<T>> {
    return this.local.transaction(async()=>this.enqueueSync(input));
  }
  /** Joins an already-owned synchronous SQLite transaction without yielding. */
  enqueueSync<T>(input: Omit<DurableJob<T>, "id" | "state" | "attempt" | "availableAt" | "createdAt" | "updatedAt"> & { availableAt?: string }): DurableJob<T> {
    const storedIdempotencyKey = `${input.cellId}:${input.idempotencyKey}`;
    const existing = this.local.database.prepare("SELECT * FROM ubeeq_jobs WHERE cell_id = ? AND idempotency_key = ?").get(input.cellId, storedIdempotencyKey) as Record<string, unknown> | undefined; if (existing) return this.row(existing) as DurableJob<T>;
    const timestamp = now(), job: DurableJob<T> = { id: randomUUID(), cellId: input.cellId, type: input.type, payload: input.payload, idempotencyKey: input.idempotencyKey, state: "queued", attempt: 0, maxAttempts: input.maxAttempts, availableAt: input.availableAt ?? timestamp, createdAt: timestamp, updatedAt: timestamp, correlationId: input.correlationId };
    try { this.write(job, undefined, storedIdempotencyKey); return job; }
    catch (error) {
      // Another process may win the unique idempotency key after our first read.
      const concurrent = this.local.database.prepare("SELECT * FROM ubeeq_jobs WHERE cell_id = ? AND idempotency_key = ?").get(input.cellId, storedIdempotencyKey) as Record<string, unknown> | undefined;
      if (concurrent) return this.row(concurrent) as DurableJob<T>;
      throw error;
    }
  }
  async lease<T>(input: { cellId: string; types?: readonly string[]; leaseDurationSeconds: number; workerId: string }): Promise<JobLease<T> | undefined> {
    if (!input.cellId.trim() || !Number.isSafeInteger(input.leaseDurationSeconds) || input.leaseDurationSeconds <= 0) throw new Error("A cell and positive integer lease duration are required.");
    return this.local.transaction(async()=>{
      const timestamp = now();
      // Recovery is scoped to this worker's cell. Crashed attempts consume the same
      // retry budget as reported failures, rather than being reclaimed forever.
      this.local.database.prepare("UPDATE ubeeq_jobs SET state = 'dead_lettered', lease_token = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE cell_id = ? AND state = 'leased' AND lease_expires_at <= ? AND attempt >= max_attempts")
        .run(json({ code: "lease_attempts_exhausted", message: "Worker leases expired through the configured attempt budget." }), timestamp, input.cellId, timestamp);
      this.local.database.prepare("UPDATE ubeeq_jobs SET state = 'retry_scheduled', available_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE cell_id = ? AND state = 'leased' AND lease_expires_at <= ?")
        .run(timestamp, timestamp, input.cellId, timestamp);
      const typeFilter = input.types?.length ? ` AND type IN (${input.types.map(() => "?").join(",")})` : "";
      const leaseToken = randomUUID(), expiresAt = new Date(Date.parse(timestamp) + input.leaseDurationSeconds * 1000).toISOString();
      const row = this.local.database.prepare(`UPDATE ubeeq_jobs SET state = 'leased', attempt = attempt + 1, lease_token = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = (SELECT id FROM ubeeq_jobs WHERE cell_id = ? AND state IN ('queued', 'retry_scheduled') AND available_at <= ?${typeFilter} ORDER BY available_at, id LIMIT 1)
        AND state IN ('queued', 'retry_scheduled') RETURNING *`)
        .get(leaseToken, expiresAt, timestamp, input.cellId, timestamp, ...(input.types ?? [])) as Record<string, unknown> | undefined;
      return row ? { job: this.row(row) as DurableJob<T>, leaseToken } : undefined;
    });
  }
  async complete(input: { id: string; leaseToken: string }): Promise<void> { await this.local.transaction(async()=>{this.transition(input.id, input.leaseToken, "completed");}); }
  async retry(input: { id: string; leaseToken: string; error: { code: string; message: string }; retryAt: string }): Promise<void> { await this.local.transaction(async()=>{this.transition(input.id, input.leaseToken, "retry_scheduled", input.error, input.retryAt);}); }
  async deadLetter(input: { id: string; leaseToken: string; error: { code: string; message: string } }): Promise<void> { await this.local.transaction(async()=>{this.transition(input.id, input.leaseToken, "dead_lettered", input.error);}); }
  async cancel(input: { id: string; reason?: string }): Promise<void> { await this.local.transaction(async()=>{this.local.database.prepare("UPDATE ubeeq_jobs SET state = 'cancelled', last_error = ?, updated_at = ? WHERE id = ?").run(input.reason ? json({ code: "cancelled", message: input.reason }) : null, now(), input.id);}); }
  async recover(input: { id: string; availableAt?: string }): Promise<DurableJob> {
    return this.local.transaction(async()=>{
      const row = this.local.database.prepare("UPDATE ubeeq_jobs SET state = 'queued', available_at = ?, lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND state IN ('retry_scheduled', 'dead_lettered') RETURNING *")
        .get(input.availableAt ?? now(), now(), input.id) as Record<string, unknown> | undefined;
      if (!row) throw new JobRecoveryError();
      return this.row(row);
    });
  }
  async get(id: string): Promise<DurableJob | undefined> { return this.local.transaction(async()=>{const row = this.local.database.prepare("SELECT * FROM ubeeq_jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined; return row ? this.row(row) : undefined;}); }
  async list(input: { cellId: string; states?: readonly DurableJob["state"][]; limit: number }): Promise<readonly DurableJob[]> { return this.local.transaction(async()=>{const limit = Math.max(1, Math.min(100, input.limit)); const stateFilter = input.states?.length ? ` AND state IN (${input.states.map(() => "?").join(",")})` : ""; const rows = this.local.database.prepare(`SELECT * FROM ubeeq_jobs WHERE cell_id = ?${stateFilter} ORDER BY created_at DESC, id DESC LIMIT ?`).all(input.cellId, ...(input.states ?? []), limit) as Record<string, unknown>[]; return rows.map((row) => this.row(row));}); }
  async schedule(input: { cellId: string; type: string; idempotencyKey: string; payload: unknown; runAt: string }): Promise<void> { await this.enqueue({ ...input, maxAttempts: 3, availableAt: input.runAt }); }
  async cancelSchedule(input: { cellId: string; idempotencyKey: string }): Promise<void> { await this.local.transaction(async()=>{this.local.database.prepare("UPDATE ubeeq_jobs SET state = 'cancelled', updated_at = ? WHERE cell_id = ? AND idempotency_key = ?").run(now(), input.cellId, `${input.cellId}:${input.idempotencyKey}`);}); }
  private row(row: Record<string, unknown>): DurableJob { const cellId = String(row.cell_id); const storedKey = String(row.idempotency_key); return { id: String(row.id), cellId, type: String(row.type), payload: parse(String(row.payload)), idempotencyKey: storedKey.startsWith(`${cellId}:`) ? storedKey.slice(cellId.length + 1) : storedKey, state: row.state as DurableJob["state"], attempt: Number(row.attempt), maxAttempts: Number(row.max_attempts), availableAt: String(row.available_at), leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined, createdAt: String(row.created_at), updatedAt: String(row.updated_at), correlationId: row.correlation_id ? String(row.correlation_id) : undefined, lastError: row.last_error ? parse(String(row.last_error)) : undefined }; }
  private write(job: DurableJob, leaseToken?: string, storedIdempotencyKey = `${job.cellId}:${job.idempotencyKey}`): void { this.local.database.prepare("INSERT INTO ubeeq_jobs (id,cell_id,type,payload,idempotency_key,state,attempt,max_attempts,available_at,lease_token,lease_expires_at,created_at,updated_at,correlation_id,last_error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, attempt=excluded.attempt, available_at=excluded.available_at, lease_token=excluded.lease_token, lease_expires_at=excluded.lease_expires_at, updated_at=excluded.updated_at, last_error=excluded.last_error").run(job.id, job.cellId, job.type, json(job.payload), storedIdempotencyKey, job.state, job.attempt, job.maxAttempts, job.availableAt, leaseToken ?? null, job.leaseExpiresAt ?? null, job.createdAt, job.updatedAt, job.correlationId ?? null, job.lastError ? json(job.lastError) : null); }
  private transition(id: string, leaseToken: string, state: DurableJob["state"], error?: { code: string; message: string }, availableAt?: string): void {
    const timestamp = now();
    const result = this.local.database.prepare("UPDATE ubeeq_jobs SET state = CASE WHEN ? = 'retry_scheduled' AND attempt >= max_attempts THEN 'dead_lettered' ELSE ? END, last_error = ?, available_at = CASE WHEN ? = 'retry_scheduled' AND attempt >= max_attempts THEN available_at ELSE COALESCE(?, available_at) END, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND state = 'leased' AND lease_token = ? AND lease_expires_at > ?")
      .run(state, state, error ? json(error) : null, state, availableAt ?? null, timestamp, id, leaseToken, timestamp);
    if (result.changes !== 1) throw new Error("Job lease is no longer valid.");
  }
}

/**
 * SQLite control-plane implementation for a single operator.  It is not part
 * of `UbeeqRepositories`: routes are intentionally outside any creator's home
 * cell data set and contain no private creator state.
 */
export class LocalRoutingDirectory implements RoutingDirectory {
  constructor(private readonly local: LocalSqliteDatabase) {}
  async get(creatorId: string): Promise<CellRoute | undefined> {
    const row = this.local.database.prepare("SELECT creator_id, home_cell_id, home_region, endpoint, routing_revision, state, updated_at FROM ubeeq_cell_routes WHERE creator_id = ?").get(creatorId) as Record<string, unknown> | undefined;
    return row ? this.route(row) : undefined;
  }
  async create(route: CellRoute): Promise<CellRoute> {
    validateCellRoute(route);
    try {
      this.local.database.prepare("INSERT INTO ubeeq_cell_routes (creator_id, home_cell_id, home_region, endpoint, routing_revision, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(route.creatorId, route.homeCellId, route.homeRegion, route.endpoint, route.routingRevision, route.state, route.updatedAt);
      return route;
    } catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) throw new RoutingDirectoryConflictError(`A route already exists for creator ${route.creatorId}.`);
      throw error;
    }
  }
  async compareAndSwap(input: { route: CellRoute; expectedRoutingRevision: number }): Promise<CellRoute> {
    validateCellRoute(input.route);
    if (input.route.routingRevision !== input.expectedRoutingRevision + 1) throw new RoutingDirectoryConflictError("The replacement route must advance routingRevision by exactly one.");
    const result = this.local.database.prepare("UPDATE ubeeq_cell_routes SET home_cell_id = ?, home_region = ?, endpoint = ?, routing_revision = ?, state = ?, updated_at = ? WHERE creator_id = ? AND routing_revision = ?").run(input.route.homeCellId, input.route.homeRegion, input.route.endpoint, input.route.routingRevision, input.route.state, input.route.updatedAt, input.route.creatorId, input.expectedRoutingRevision);
    if (result.changes !== 1) throw new RoutingDirectoryConflictError(`Route revision ${input.expectedRoutingRevision} is no longer current for creator ${input.route.creatorId}.`);
    return input.route;
  }
  async list(input: { limit: number; cursor?: string }): Promise<{ items: readonly CellRoute[]; nextCursor?: string }> {
    const limit = Math.max(1, Math.min(100, input.limit)), after = input.cursor ? Buffer.from(input.cursor, "base64url").toString("utf8") : "";
    const rows = this.local.database.prepare("SELECT creator_id, home_cell_id, home_region, endpoint, routing_revision, state, updated_at FROM ubeeq_cell_routes WHERE creator_id > ? ORDER BY creator_id LIMIT ?").all(after, limit + 1) as Record<string, unknown>[];
    const items = rows.slice(0, limit).map((row) => this.route(row));
    return { items, nextCursor: rows.length > limit ? Buffer.from(items.at(-1)!.creatorId).toString("base64url") : undefined };
  }
  private route(row: Record<string, unknown>): CellRoute { return validateCellRoute({ creatorId: String(row.creator_id), homeCellId: String(row.home_cell_id), homeRegion: String(row.home_region), endpoint: String(row.endpoint), routingRevision: Number(row.routing_revision), state: row.state as CellRoute["state"], updatedAt: String(row.updated_at) }); }
}

/** Durable migration state lets a worker resume after a process restart. */
export class LocalMigrationCheckpoints implements MigrationCheckpointStore {
  constructor(private readonly local: LocalSqliteDatabase) {}
  async get(id: string): Promise<MigrationCheckpoint | undefined> {
    const row = this.local.database.prepare("SELECT payload FROM ubeeq_migration_checkpoints WHERE id = ?").get(id) as { payload?: string } | undefined;
    return row?.payload ? validateMigrationCheckpoint(parse<MigrationCheckpoint>(row.payload)) : undefined;
  }
  async create(checkpoint: MigrationCheckpoint): Promise<MigrationCheckpoint> {
    validateMigrationCheckpoint(checkpoint);
    try {
      this.local.database.prepare("INSERT INTO ubeeq_migration_checkpoints (id, creator_id, payload, updated_at) VALUES (?, ?, ?, ?)").run(checkpoint.id, checkpoint.creatorId, json(checkpoint), checkpoint.updatedAt);
      return checkpoint;
    } catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) throw new RoutingDirectoryConflictError(`Migration checkpoint ${checkpoint.id} already exists.`);
      throw error;
    }
  }
  async compareAndSwap(input: { checkpoint: MigrationCheckpoint; expectedUpdatedAt: string }): Promise<MigrationCheckpoint> {
    validateMigrationCheckpoint(input.checkpoint);
    if (input.checkpoint.updatedAt === input.expectedUpdatedAt) throw new RoutingDirectoryConflictError("A migration update must advance updatedAt.");
    const result = this.local.database.prepare("UPDATE ubeeq_migration_checkpoints SET creator_id = ?, payload = ?, updated_at = ? WHERE id = ? AND updated_at = ?").run(input.checkpoint.creatorId, json(input.checkpoint), input.checkpoint.updatedAt, input.checkpoint.id, input.expectedUpdatedAt);
    if (result.changes !== 1) throw new RoutingDirectoryConflictError(`Migration checkpoint ${input.checkpoint.id} has changed.`);
    return input.checkpoint;
  }
  async list(input: { creatorId?: string; limit: number; cursor?: string }): Promise<{ items: readonly MigrationCheckpoint[]; nextCursor?: string }> {
    const limit = Math.max(1, Math.min(100, input.limit)), after = input.cursor ? Buffer.from(input.cursor, "base64url").toString("utf8") : "";
    const rows = input.creatorId
      ? this.local.database.prepare("SELECT id, payload FROM ubeeq_migration_checkpoints WHERE creator_id = ? AND id > ? ORDER BY id LIMIT ?").all(input.creatorId, after, limit + 1)
      : this.local.database.prepare("SELECT id, payload FROM ubeeq_migration_checkpoints WHERE id > ? ORDER BY id LIMIT ?").all(after, limit + 1);
    const typed = rows as Array<{ id: string; payload: string }>, items = typed.slice(0, limit).map((row) => validateMigrationCheckpoint(parse<MigrationCheckpoint>(row.payload)));
    return { items, nextCursor: typed.length > limit ? Buffer.from(items.at(-1)!.id).toString("base64url") : undefined };
  }
}

export * from './creator-members.js';
export * from './creator-source-files.js';
export * from './export-related-lookup.js';
export const createLocalAdapterSet = (configuration: LocalAdapterConfiguration) => {
  const database = new LocalSqliteDatabase(configuration);
  const storage = new LocalFilesystemStorage(database);
  return { database, repositories: createLocalRepositories(database), storage, identity: new LocalIdentityAdapter(database), credentials: new LocalCredentialVault(database), federation: new LocalFederationKey(database), jobs: new LocalSqliteJobQueue(database), routingDirectory: new LocalRoutingDirectory(database), migrationCheckpoints: new LocalMigrationCheckpoints(database) };
};
export { LocalSmugMugInventoryRunner, type LocalSmugMugInventoryRunnerOptions } from './smugmug-inventory-runner.js';
export { LocalFlickrRepository } from './flickr-repository.js';
export { LocalActivityWorkflowStore } from './activity-workflows.js';
