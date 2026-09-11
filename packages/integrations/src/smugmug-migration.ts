import { createHash, randomUUID } from 'node:crypto';
import type { SmugMugCapabilities, SmugMugRemoteCollection, SmugMugRemoteImage, SmugMugInventoryPage, SmugMugGateway } from './smugmug-contracts.js';
export type { SmugMugCapabilities, SmugMugRemoteCollection, SmugMugRemoteImage, SmugMugInventoryPage, SmugMugGateway } from './smugmug-contracts.js';

export type SmugMugMigrationMode = 'REFERENCE_ONLY' | 'SELECTED_SOURCE_MIGRATION' | 'FULL_CATALOGUE_MIGRATION';
export type SmugMugSourceQuality = 'ORIGINAL' | 'HIGHEST_AVAILABLE' | 'EXTERNAL_REFERENCE_ONLY';


export interface SmugMugConnection {
  id: string;
  userId: string;
  creatorId: string;
  accountId?: string;
  accountName?: string;
  encryptedCredentialRef?: string;
  oauthState: string;
  oauthExpiresAt?: number;
  capabilities?: SmugMugCapabilities;
  state: 'AUTHORIZING' | 'CONNECTED' | 'INVENTORY_READY' | 'DISCONNECTED' | 'ERROR';
  inventoryCursor?: string;
  inventoryScopeId?: string;
  completedInventoryScopeId?: string;
  inventoryInProgress?: boolean;
  inventoryPagesComplete?: boolean;
  inventorySummary?: { imageCount: number; collectionCount: number; estimatedBytes: number; originalDownloads: boolean; imagesComplete: boolean; collectionsComplete: boolean; imageAfter?: string; collectionAfter?: string };
  lastInventoryAt?: string;
  lastSyncAt?: string;
  createdAt: string;
  updatedAt: string;
}


export interface SmugMugMigration {
  inventoryScopeId?: string;
  inventoryCounts?: { imageCount: number; collectionCount: number };
  inventoryOriginalDownloads?: boolean;
  itemsInitialized?: boolean;
  initializationAfterRemoteId?: string;
  /** Saved position and outcome across a bounded sweep; cleared at its end. */
  resumeAfterRemoteId?: string;
  resumeHasFailures?: boolean;
  id: string;
  connectionId: string;
  userId: string;
  creatorId: string;
  mode?: SmugMugMigrationMode;
  selectedGalleryIds: string[];
  status: 'REVIEW' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'PAUSED';
  estimatedBytes: number;
  createdAt: string;
  updatedAt: string;
}

export type SmugMugInventoryResult =
  | { connection: SmugMugConnection; complete: false; cursor?: string; migration?: undefined; imageCount?: undefined; collectionCount?: undefined }
  | { connection: SmugMugConnection; complete: true; cursor?: undefined; migration: SmugMugMigration; imageCount: number; collectionCount: number };

export interface SmugMugMigrationItem {
  migrationId: string;
  remoteId: string;
  requestedQuality: SmugMugSourceQuality;
  state: 'PENDING' | 'REFERENCE_IMPORTED' | 'TRANSFERRED' | 'DEDUPLICATED' | 'QUARANTINED' | 'FAILED';
  attempts: number;
  idempotencyKey: string;
  checksum?: string;
  canonicalAssetId?: string;
  errorCode?: string;
}


export interface SmugMugOutboundSource {
  load(creatorId: string, workId: string): Promise<{ body: Buffer; filename: string; mimeType: string; title: string; caption?: string; keywords: string[] }>;
  record(input: { connectionId: string; creatorId: string; workId: string; remoteId: string; remoteUrl?: string; remoteUri?: string; visibility: 'private' | 'unlisted' | 'public' }): Promise<void>;
  loadMetadata(connectionId: string, creatorId: string, workId: string): Promise<{ remoteUri: string; title: string; caption?: string; keywords: string[] }>;
  recordMetadataSync(connectionId: string, creatorId: string, workId: string): Promise<void>;
}

export interface SmugMugMigrationSink {
  importReference(input: { connectionId: string; creatorId: string; image: SmugMugRemoteImage; collections: SmugMugRemoteCollection[] }): Promise<void>;
  findAssetByChecksum(creatorId: string, checksum: string, context?: { connectionId: string; image: SmugMugRemoteImage }): Promise<string | undefined>;
  reuseAsset?(input: { connectionId: string; creatorId: string; image: SmugMugRemoteImage; assetId: string; checksum: string }): Promise<void>;
  quarantine(input: { connectionId: string; creatorId: string; image: SmugMugRemoteImage; body: Buffer; mimeType: string; checksum: string }): Promise<{ assetId: string; scanPassed: boolean }>;
}

export interface SmugMugRepository {
  listConnectionPage(userId: string, creatorId: string, limit: number, afterId?: string): Promise<{ items: SmugMugConnection[]; nextAfterConnectionId?: string; legacyLookupMayBeRequired: boolean }>;
  putConnection(connection: SmugMugConnection): Promise<void>;
  putConnectionIfUnchanged(connection: SmugMugConnection, expected: SmugMugConnection): Promise<boolean>;
  getConnection(id: string): Promise<SmugMugConnection | undefined>;
  findAuthorizingConnection(oauthState: string): Promise<SmugMugConnection | undefined>;
  claimOAuth(connection: SmugMugConnection, now: number): Promise<boolean>;
  putMigration(migration: SmugMugMigration): Promise<void>;
  putMigrationIfUnchanged(migration: SmugMugMigration, expected: SmugMugMigration): Promise<boolean>;
  completeInventory(connection: SmugMugConnection, expected: SmugMugConnection, migration: SmugMugMigration): Promise<boolean>;
  getMigration(id: string): Promise<SmugMugMigration | undefined>;
  listMigrationPage(connectionId: string, limit: number, afterId?: string): Promise<{ items: SmugMugMigration[]; nextAfterMigrationId?: string; legacyLookupMayBeRequired: boolean }>;
  mergeCollections(connectionId: string, collections: SmugMugRemoteCollection[]): Promise<void>;
  mergeInventoryPage(expected: SmugMugConnection, collections: SmugMugRemoteCollection[], images: SmugMugRemoteImage[]): Promise<void>;
  getCollections(connectionId: string): Promise<SmugMugRemoteCollection[]>;
  getCollectionPage(connectionId: string, limit: number, afterRemoteId?: string): Promise<{ items: SmugMugRemoteCollection[]; nextAfterRemoteId?: string }>;
  getCollection(connectionId: string, remoteId: string): Promise<SmugMugRemoteCollection | undefined>;
  mergeImages(connectionId: string, images: SmugMugRemoteImage[]): Promise<void>;
  getImages(connectionId: string): Promise<SmugMugRemoteImage[]>;
  getImagePage(connectionId: string, limit: number, afterRemoteId?: string): Promise<{ items: SmugMugRemoteImage[]; nextAfterRemoteId?: string }>;
  getImage(connectionId: string, remoteId: string): Promise<SmugMugRemoteImage | undefined>;
  putItems(migrationId: string, items: SmugMugMigrationItem[]): Promise<void>;
  putItem(migrationId: string, item: SmugMugMigrationItem): Promise<void>;
  putItemIfAbsent(migrationId: string, item: SmugMugMigrationItem): Promise<void>;
  getItems(migrationId: string): Promise<SmugMugMigrationItem[]>;
  getItemPage(migrationId: string, limit: number, afterRemoteId?: string): Promise<{ items: SmugMugMigrationItem[]; nextAfterRemoteId?: string }>;
}

export class InMemorySmugMugRepository implements SmugMugRepository {
  constructor(private readonly changed: () => void = () => undefined) {}
  private readonly oauthClaims = new Set<string>();
  connections = new Map<string, SmugMugConnection>();
  migrations = new Map<string, SmugMugMigration>();
  collections = new Map<string, SmugMugRemoteCollection[]>();
  images = new Map<string, SmugMugRemoteImage[]>();
  items = new Map<string, SmugMugMigrationItem[]>();
  async putConnection(value: SmugMugConnection) { this.connections.set(value.id, structuredClone(value)); this.changed(); }
  async putConnectionIfUnchanged(value: SmugMugConnection, expected: SmugMugConnection) {
    validateConnectionCheckpoint(value, expected);
    if (JSON.stringify(this.connections.get(value.id)) !== JSON.stringify(expected)) return false;
    this.connections.set(value.id, structuredClone(value)); this.changed(); return true;
  }
  async getConnection(id: string) { const value = this.connections.get(id); return value && structuredClone(value); }
  async listConnectionPage(userId: string, creatorId: string, limit: number, afterId?: string) {
    validateSmugMugItemPage(limit, afterId);
    const rows = [...this.connections.values()].filter(value => value.userId === userId && value.creatorId === creatorId
      && (afterId === undefined || Buffer.compare(Buffer.from(value.id), Buffer.from(afterId)) > 0))
      .sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))).slice(0, limit + 1);
    const items = structuredClone(rows.slice(0, limit));
    return { items, ...(rows.length > limit ? { nextAfterConnectionId: items.at(-1)!.id } : {}), legacyLookupMayBeRequired: false };
  }
  async findAuthorizingConnection(state: string) { const value = [...this.connections.values()].find((item) => item.oauthState === state && item.state === 'AUTHORIZING'); return value && structuredClone(value); }
  async claimOAuth(connection: SmugMugConnection, now: number) {
    if (!isSmugMugOAuthClaimable(connection, now) || this.oauthClaims.has(connection.oauthState)) return false;
    if (JSON.stringify(this.connections.get(connection.id)) !== JSON.stringify(connection)) return false;
    this.oauthClaims.add(connection.oauthState);
    this.changed();
    return true;
  }
  async putMigration(value: SmugMugMigration) { this.migrations.set(value.id, structuredClone(value)); this.changed(); }
  async completeInventory(connection: SmugMugConnection, expected: SmugMugConnection, migration: SmugMugMigration) {
    validateInventoryCompletion(connection, expected, migration);
    if (JSON.stringify(this.connections.get(connection.id)) !== JSON.stringify(expected) || this.migrations.has(migration.id)) return false;
    const nextConnection = structuredClone(connection), nextMigration = structuredClone(migration);
    this.connections.set(connection.id, nextConnection); this.migrations.set(migration.id, nextMigration);
    this.changed(); return true;
  }
  async putMigrationIfUnchanged(value: SmugMugMigration, expected: SmugMugMigration) {
    if (value.id !== expected.id) throw new Error('Migration identity mismatch.');
    if (JSON.stringify(this.migrations.get(value.id)) !== JSON.stringify(expected)) return false;
    this.migrations.set(value.id, structuredClone(value)); this.changed(); return true;
  }
  async getMigration(id: string) { const value = this.migrations.get(id); return value && structuredClone(value); }
  async listMigrationPage(connectionId: string, limit: number, afterId?: string) {
    validateSmugMugItemPage(limit, afterId);
    const rows = [...this.migrations.values()].filter(value => value.connectionId === connectionId
      && (afterId === undefined || Buffer.compare(Buffer.from(value.id), Buffer.from(afterId)) > 0))
      .sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))).slice(0, limit + 1);
    const items = structuredClone(rows.slice(0, limit));
    return { items, ...(rows.length > limit ? { nextAfterMigrationId: items.at(-1)!.id } : {}), legacyLookupMayBeRequired: false };
  }
  async mergeCollections(id: string, values: SmugMugRemoteCollection[]) { this.collections.set(id, this.merge(this.collections.get(id) || [], values)); this.changed(); }
  async mergeInventoryPage(expected: SmugMugConnection, collections: SmugMugRemoteCollection[], images: SmugMugRemoteImage[]) {
    validateInventoryPageWrite(expected, collections, images);
    if (JSON.stringify(this.connections.get(expected.id)) !== JSON.stringify(expected)) throw new SmugMugError('INVENTORY_WRITE_CONFLICT', 409);
    const scope = expected.inventoryScopeId!;
    const nextCollections = structuredClone(this.merge(this.collections.get(scope) || [], collections));
    const nextImages = structuredClone(this.merge(this.images.get(scope) || [], images));
    this.collections.set(scope, nextCollections); this.images.set(scope, nextImages); this.changed();
  }
  async getCollections(id: string) { return structuredClone(this.collections.get(id) || []); }
  async getCollectionPage(id: string, limit: number, afterRemoteId?: string) {
    validateSmugMugItemPage(limit, afterRemoteId);
    const rows = (this.collections.get(id) || []).filter(item => afterRemoteId === undefined || Buffer.compare(Buffer.from(item.remoteId), Buffer.from(afterRemoteId)) > 0)
      .sort((a, b) => Buffer.compare(Buffer.from(a.remoteId), Buffer.from(b.remoteId))).slice(0, limit + 1);
    const items = structuredClone(rows.slice(0, limit));
    return { items, ...(rows.length > limit ? { nextAfterRemoteId: items.at(-1)!.remoteId } : {}) };
  }
  async getCollection(id: string, remoteId: string) { return structuredClone(this.collections.get(id)?.find(value => value.remoteId === remoteId)); }
  async mergeImages(id: string, values: SmugMugRemoteImage[]) { this.images.set(id, this.merge(this.images.get(id) || [], values)); this.changed(); }
  async getImages(id: string) { return structuredClone(this.images.get(id) || []); }
  async getImagePage(id: string, limit: number, afterRemoteId?: string) {
    validateSmugMugItemPage(limit, afterRemoteId);
    const rows = (this.images.get(id) || []).filter(item => afterRemoteId === undefined || Buffer.compare(Buffer.from(item.remoteId), Buffer.from(afterRemoteId)) > 0)
      .sort((a, b) => Buffer.compare(Buffer.from(a.remoteId), Buffer.from(b.remoteId))).slice(0, limit + 1);
    const items = structuredClone(rows.slice(0, limit));
    return { items, ...(rows.length > limit ? { nextAfterRemoteId: items.at(-1)!.remoteId } : {}) };
  }
  async getImage(id: string, remoteId: string) { return structuredClone(this.images.get(id)?.find(value => value.remoteId === remoteId)); }
  async putItems(id: string, values: SmugMugMigrationItem[]) { this.items.set(id, structuredClone(values)); this.changed(); }
  async putItem(id: string, value: SmugMugMigrationItem) {
    if (value.migrationId !== id) throw new Error('Migration item identity mismatch.');
    const items = [...(this.items.get(id) || [])], index = items.findIndex(item => item.remoteId === value.remoteId);
    if (index < 0) items.push(structuredClone(value)); else items[index] = structuredClone(value);
    this.items.set(id, items);
    this.changed();
  }
  async getItems(id: string) { return structuredClone(this.items.get(id) || []); }
  async putItemIfAbsent(id: string, value: SmugMugMigrationItem) {
    if (value.migrationId !== id) throw new Error('Migration item identity mismatch.');
    const existing = this.items.get(id)?.find(item => item.remoteId === value.remoteId);
    if (existing) {
      if (existing.migrationId !== id || existing.idempotencyKey !== value.idempotencyKey) throw new Error('Migration item initialization conflict.');
      return;
    }
    await this.putItem(id, value);
  }
  async getItemPage(id: string, limit: number, afterRemoteId?: string) {
    validateSmugMugItemPage(limit, afterRemoteId);
    const rows = (this.items.get(id) || []).filter(item => afterRemoteId === undefined || Buffer.compare(Buffer.from(item.remoteId), Buffer.from(afterRemoteId)) > 0)
      .sort((a, b) => Buffer.compare(Buffer.from(a.remoteId), Buffer.from(b.remoteId))).slice(0, limit + 1);
    const items = structuredClone(rows.slice(0, limit));
    return { items, ...(rows.length > limit ? { nextAfterRemoteId: items.at(-1)!.remoteId } : {}) };
  }
  captureState() {
    return structuredClone({ connections: [...this.connections], migrations: [...this.migrations], collections: [...this.collections], images: [...this.images], items: [...this.items], oauthClaims: [...this.oauthClaims] });
  }
  restoreState(snapshot: ReturnType<InMemorySmugMugRepository['captureState']>) {
    if (!snapshot || typeof snapshot !== 'object') throw new Error('Invalid SmugMug checkpoint.');
    for (const key of ['connections', 'migrations', 'collections', 'images', 'items'] as const) {
      const entries = snapshot[key];
      if (!Array.isArray(entries) || new Set(entries.map(entry => Array.isArray(entry) ? entry[0] : undefined)).size !== entries.length
        || entries.some(entry => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0].trim()
          || (key === 'connections' || key === 'migrations' ? !entry[1] || Array.isArray(entry[1]) || typeof entry[1] !== 'object' || (entry[1] as { id?: string }).id !== entry[0] : !Array.isArray(entry[1])))) throw new Error('Invalid SmugMug checkpoint.');
    }
    if (!Array.isArray(snapshot.oauthClaims) || snapshot.oauthClaims.some(value => typeof value !== 'string' || !value.trim())) throw new Error('Invalid SmugMug checkpoint.');
    const nonblank = (value: unknown) => typeof value === 'string' && Boolean(value.trim());
    for (const [, value] of [...snapshot.connections, ...snapshot.migrations]) {
      if (!nonblank(value.userId) || !nonblank(value.creatorId)) throw new Error('Invalid SmugMug checkpoint identity.');
    }
    for (const key of ['collections', 'images', 'items'] as const) {
      for (const [id, values] of snapshot[key]) {
        if (values.some(value => !value || typeof value !== 'object' || !nonblank(value.remoteId)
          || (key === 'items' && (value as SmugMugMigrationItem).migrationId !== id))) throw new Error('Invalid SmugMug checkpoint item.');
      }
    }
    const copy = structuredClone(snapshot);
    this.connections = new Map(copy.connections); this.migrations = new Map(copy.migrations);
    this.collections = new Map(copy.collections); this.images = new Map(copy.images); this.items = new Map(copy.items);
    this.oauthClaims.clear(); for (const value of copy.oauthClaims) this.oauthClaims.add(value);
  }
  private merge<T extends { remoteId: string }>(current: T[], incoming: T[]) { return [...new Map([...current, ...incoming].map((item) => [item.remoteId, item])).values()]; }
}

/** Connector workflow with injected admission, persistence and content ports.
 * Inventory/import never dispatch provider writes; outbound methods require explicit invocation.
 */
export class SmugMugIntegrationService {
  constructor(
    private readonly gateway: SmugMugGateway,
    private readonly sink: SmugMugMigrationSink,
    readonly repository: SmugMugRepository = new InMemorySmugMugRepository(),
    private readonly outbound?: SmugMugOutboundSource,
    private readonly canManageCreator: (userId: string, creatorId: string) => Promise<boolean> = async () => false
  ) {}

  async start(userId: string, creatorId: string) {
    await this.requireCreatorAdmission(userId, creatorId);
    const now = new Date().toISOString();
    const connection: SmugMugConnection = { id: randomUUID(), userId, creatorId, oauthState: randomUUID(), oauthExpiresAt: Date.now() + 10 * 60_000, state: 'AUTHORIZING', createdAt: now, updatedAt: now };
    const auth = await this.gateway.startAuthorization(connection.oauthState);
    await this.requireCreatorAdmission(userId, creatorId);
    connection.encryptedCredentialRef = auth.credentialRef;
    await this.repository.putConnection(connection);
    return { connection, authorizationUrl: auth.authorizationUrl };
  }

  async callback(state: string, verifier: string) {
    if (![state, verifier].every(value => typeof value === 'string' && value.trim())) throw new SmugMugError('INVALID_OAUTH_STATE', 400);
    const connection = await this.repository.findAuthorizingConnection(state);
    if (!connection || connection.oauthState !== state || !isSmugMugOAuthClaimable(connection, Date.now())) throw new SmugMugError('INVALID_OAUTH_STATE', 400);
    await this.requireCreatorAdmission(connection.userId, connection.creatorId);
    if (!await this.repository.claimOAuth(connection, Date.now())) throw new SmugMugError('INVALID_OAUTH_STATE', 400);
    const account = await this.gateway.completeAuthorization(connection.encryptedCredentialRef!, verifier);
    await this.requireCreatorAdmission(connection.userId, connection.creatorId);
    Object.assign(connection, account, { encryptedCredentialRef: account.credentialRef, state: 'CONNECTED', updatedAt: new Date().toISOString() });
    await this.repository.putConnection(connection);
    return connection;
  }

  private async requireCreatorAdmission(userId: string, creatorId: string) {
    if (!await this.canManageCreator(userId, creatorId)) throw new SmugMugError('CREATOR_FORBIDDEN', 403);
  }

  async inspectConnection(id: string, userId: string) {
    const connection = await this.ownedConnection(id, userId, false);
    await this.requireCreatorAdmission(userId, connection.creatorId);
    return connection;
  }

  async listConnections(userId: string, creatorId: string, limit = 50, afterId?: string) {
    validateSmugMugItemPage(limit, afterId);
    await this.requireCreatorAdmission(userId, creatorId);
    const page = await this.repository.listConnectionPage(userId, creatorId, limit, afterId);
    if (page.items.some(connection => connection.userId !== userId || connection.creatorId !== creatorId)) throw new SmugMugError('CONNECTION_FORBIDDEN', 403);
    await this.requireCreatorAdmission(userId, creatorId);
    return page;
  }

  async inspectMigration(id: string, userId: string, limit = 50, afterRemoteId?: string) {
    validateSmugMugItemPage(limit, afterRemoteId);
    const migration = await this.ownedMigration(id, userId, false);
    const page = await this.repository.getItemPage(id, limit, afterRemoteId);
    if (page.items.some(item => item.migrationId !== id)) throw new SmugMugError('MIGRATION_CONNECTION_MISMATCH', 409);
    const current = await this.ownedMigration(id, userId, false);
    if (current.connectionId !== migration.connectionId || current.creatorId !== migration.creatorId) throw new SmugMugError('MIGRATION_CONNECTION_MISMATCH', 409);
    return { migration, ...page };
  }

  async listMigrations(connectionId: string, userId: string, limit = 50, afterId?: string) {
    validateSmugMugItemPage(limit, afterId);
    const connection = await this.inspectConnection(connectionId, userId);
    const page = await this.repository.listMigrationPage(connectionId, limit, afterId);
    if (page.items.some(migration => migration.connectionId !== connectionId || migration.userId !== userId || migration.creatorId !== connection.creatorId)) throw new SmugMugError('MIGRATION_CONNECTION_MISMATCH', 409);
    const current = await this.inspectConnection(connectionId, userId);
    if (current.creatorId !== connection.creatorId) throw new SmugMugError('CONNECTION_CHANGED', 409);
    return page;
  }

  async ownedConnection(id: string, userId: string, requireCreatorAccess = true) {
    const connection = await this.repository.getConnection(id);
    if (!connection) throw new SmugMugError('CONNECTION_NOT_FOUND', 404);
    if (connection.userId !== userId) throw new SmugMugError('CONNECTION_FORBIDDEN', 403);
    if (requireCreatorAccess) {
      await this.requireCreatorAdmission(userId, connection.creatorId);
      if (!['CONNECTED', 'INVENTORY_READY'].includes(connection.state) || !connection.encryptedCredentialRef || !connection.accountId) throw new SmugMugError('CONNECTION_UNAVAILABLE', 409);
    }
    return connection;
  }

  private async requireCurrentConnection(expected: SmugMugConnection) {
    try {
      const current = await this.ownedConnection(expected.id, expected.userId);
      if (current.creatorId !== expected.creatorId || current.accountId !== expected.accountId
        || current.encryptedCredentialRef !== expected.encryptedCredentialRef) throw new SmugMugError('CONNECTION_CHANGED', 409);
    } catch (error) {
      throw new SmugMugAdmissionError(error instanceof SmugMugError ? error.code : 'ADMISSION_UNAVAILABLE', error instanceof SmugMugError ? error.status : 503);
    }
  }

  async inventory(id: string, userId: string, requestId?: string): Promise<SmugMugInventoryResult> {
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId))) throw new SmugMugError('INVALID_INVENTORY_REQUEST_ID', 400);
    const connection = await this.ownedConnection(id, userId);
    // Scope keys include the connection because metadata is stored by scope, not
    // by the caller's request ID. Never share one caller-selected namespace.
    const requestedScope = requestId === undefined ? undefined : `inventory-${createHash('sha256').update(JSON.stringify([id, requestId])).digest('hex')}`;
    if (requestedScope) {
      const receipt = await this.repository.getMigration(this.inventoryMigrationId(id, requestedScope));
      if (receipt) {
        if (receipt.connectionId !== id || receipt.userId !== userId || receipt.creatorId !== connection.creatorId || receipt.inventoryScopeId !== requestedScope
          || !receipt.inventoryCounts || ![receipt.inventoryCounts.imageCount, receipt.inventoryCounts.collectionCount].every(value => Number.isSafeInteger(value) && value >= 0)) throw new SmugMugError('INVENTORY_RECEIPT_MISMATCH', 409);
        await this.requireCurrentConnection(connection);
        return { connection, complete: true, migration: receipt, imageCount: receipt.inventoryCounts.imageCount, collectionCount: receipt.inventoryCounts.collectionCount };
      }
      if (connection.inventoryInProgress && connection.inventoryScopeId !== requestedScope) throw new SmugMugError('INVENTORY_RUN_CONFLICT', 409);
    }
    if (!connection.inventoryInProgress) {
      const expected = structuredClone(connection);
      connection.inventoryScopeId = requestedScope ?? `inventory-${randomUUID()}`;
      connection.inventoryInProgress = true;
      connection.inventoryPagesComplete = false;
      delete connection.inventorySummary;
      connection.inventoryCursor = undefined;
      if (!(await this.repository.putConnectionIfUnchanged(connection, expected))) throw new SmugMugError('INVENTORY_START_CONFLICT', 409);
    }
    if (!connection.inventoryScopeId) throw new SmugMugError('INVENTORY_SCOPE_MISSING', 409);
    const scope = connection.inventoryScopeId;
    if (!connection.inventoryPagesComplete) {
      const previous = structuredClone(connection);
      await this.requireCurrentConnection(connection);
      const page = await this.gateway.inventory(connection.encryptedCredentialRef!, connection.inventoryCursor);
      await this.requireCurrentConnection(connection);
      const cursor = page.nextCursor;
      if (cursor && cursor === connection.inventoryCursor) throw new SmugMugError('INVENTORY_CURSOR_STALLED', 409);
      await this.repository.mergeInventoryPage(previous, page.collections, page.images);
      connection.inventoryCursor = cursor;
      connection.inventoryPagesComplete = !cursor;
      connection.updatedAt = new Date().toISOString();
      if (!(await this.repository.putConnectionIfUnchanged(connection, previous))) throw new SmugMugError('INVENTORY_PAGE_CONFLICT', 409);
      if (cursor) return { connection, complete: false, cursor };
    }
    return this.finalizeInventory(connection, userId, scope);
  }

  private inventoryMigrationId(connectionId: string, scope: string): string {
    return `inventory-result-${createHash('sha256').update(JSON.stringify([connectionId, scope])).digest('hex')}`;
  }

  private async finalizeInventory(connection: SmugMugConnection, userId: string, scope: string): Promise<SmugMugInventoryResult> {
    const expected = structuredClone(connection);
    const summary: NonNullable<SmugMugConnection['inventorySummary']> = connection.inventorySummary ?? { imageCount: 0, collectionCount: 0, estimatedBytes: 0, originalDownloads: false, imagesComplete: false, collectionsComplete: false };
    if (!summary.imagesComplete) {
      const page = await this.repository.getImagePage(scope, 100, summary.imageAfter);
      if (page.items.length > 100 || (page.nextAfterRemoteId && page.nextAfterRemoteId === summary.imageAfter)) throw new SmugMugError('INVALID_SUMMARY_PAGE', 409);
      for (const image of page.items) {
        const bytes = image.byteSize ?? 0;
        if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(summary.estimatedBytes + bytes)) throw new SmugMugError('INVALID_INVENTORY_SIZE', 409);
        summary.imageCount += 1; summary.estimatedBytes += bytes;
        summary.originalDownloads ||= image.originalAvailable;
      }
      summary.imageAfter = page.nextAfterRemoteId;
      summary.imagesComplete = !page.nextAfterRemoteId;
    }
    if (summary.imagesComplete && !summary.collectionsComplete) {
      const page = await this.repository.getCollectionPage(scope, 100, summary.collectionAfter);
      if (page.items.length > 100 || (page.nextAfterRemoteId && page.nextAfterRemoteId === summary.collectionAfter)) throw new SmugMugError('INVALID_SUMMARY_PAGE', 409);
      summary.collectionCount += page.items.length;
      summary.collectionAfter = page.nextAfterRemoteId;
      summary.collectionsComplete = !page.nextAfterRemoteId;
    }
    connection.inventorySummary = summary;
    await this.requireCurrentConnection(expected);
    if (!summary.imagesComplete || !summary.collectionsComplete) {
      connection.updatedAt = new Date().toISOString();
      if (!(await this.repository.putConnectionIfUnchanged(connection, expected))) throw new SmugMugError('INVENTORY_SUMMARY_CONFLICT', 409);
      return { connection, complete: false, cursor: undefined };
    }
    connection.state = 'INVENTORY_READY';
    connection.lastInventoryAt = connection.updatedAt = new Date().toISOString();
    connection.capabilities = { ...(connection.capabilities || { inventory: true, exif: false, passwordProtectedGalleries: false }), originalDownloads: summary.originalDownloads };
    const migration: SmugMugMigration = {
      id: this.inventoryMigrationId(connection.id, scope), connectionId: connection.id, inventoryScopeId: scope, inventoryCounts: { imageCount: summary.imageCount, collectionCount: summary.collectionCount }, inventoryOriginalDownloads: connection.capabilities.originalDownloads, userId, creatorId: connection.creatorId, selectedGalleryIds: [], status: 'REVIEW',
      estimatedBytes: summary.estimatedBytes, createdAt: connection.updatedAt, updatedAt: connection.updatedAt
    };
    connection.inventoryInProgress = false;
    connection.completedInventoryScopeId = scope;
    await this.requireCurrentConnection(expected);
    if (!(await this.repository.completeInventory(connection, expected, migration))) throw new SmugMugError('INVENTORY_COMPLETION_CONFLICT', 409);
    return { connection, complete: true, migration, collectionCount: summary.collectionCount, imageCount: summary.imageCount };
  }

  async confirm(migrationId: string, userId: string, mode: SmugMugMigrationMode, selectedGalleryIds: string[] = []) {
    const migration = await this.ownedMigration(migrationId, userId);
    if (migration.status !== 'REVIEW') throw new SmugMugError('MIGRATION_ALREADY_CONFIRMED', 409);
    const expected = structuredClone(migration);
    if (mode === 'SELECTED_SOURCE_MIGRATION' && selectedGalleryIds.length === 0) throw new SmugMugError('GALLERY_SELECTION_REQUIRED', 400);
    migration.mode = mode;
    migration.selectedGalleryIds = [...new Set(selectedGalleryIds)];
    migration.status = 'RUNNING';
    migration.itemsInitialized = false;
    migration.updatedAt = new Date().toISOString();
    if (!(await this.repository.putMigrationIfUnchanged(migration, expected))) throw new SmugMugError('MIGRATION_CONFIRM_CONFLICT', 409);
    return this.resume(migrationId, userId);
  }

  private async initializeItems(migration: SmugMugMigration, connection: SmugMugConnection) {
    const page = await this.repository.getImagePage(migration.inventoryScopeId || connection.id, 100, migration.initializationAfterRemoteId);
    if (page.items.length > 100 || (page.nextAfterRemoteId && page.nextAfterRemoteId === migration.initializationAfterRemoteId)) throw new SmugMugError('INVALID_INITIALIZATION_PAGE', 409);
    const images = page.items.filter(image => migration.mode !== 'SELECTED_SOURCE_MIGRATION' || migration.selectedGalleryIds.includes(image.galleryId));
    for (const image of images) {
      await this.requireCurrentConnection(connection);
      await this.repository.putItemIfAbsent(migration.id, {
        migrationId: migration.id, remoteId: image.remoteId,
        requestedQuality: migration.mode === 'REFERENCE_ONLY' || !(migration.inventoryOriginalDownloads ?? connection.capabilities?.originalDownloads) || !image.originalAvailable ? 'EXTERNAL_REFERENCE_ONLY' : 'HIGHEST_AVAILABLE',
        state: 'PENDING', attempts: 0, idempotencyKey: createHash('sha256').update(`${migration.id}:${image.remoteId}:${migration.mode}`).digest('hex')
      });
    }
    await this.requireCurrentConnection(connection);
    const ready = { ...migration, itemsInitialized: !page.nextAfterRemoteId, updatedAt: new Date().toISOString() };
    if (page.nextAfterRemoteId) ready.initializationAfterRemoteId = page.nextAfterRemoteId;
    else delete ready.initializationAfterRemoteId;
    if (!(await this.repository.putMigrationIfUnchanged(ready, migration))) throw new SmugMugError('MIGRATION_INITIALIZATION_CONFLICT', 409);
    Object.assign(migration, ready);
    if (!page.nextAfterRemoteId) delete migration.initializationAfterRemoteId;
  }

  async resume(migrationId: string, userId: string) {
    const migration = await this.ownedMigration(migrationId, userId);
    if (!migration.mode) throw new SmugMugError('MIGRATION_NOT_CONFIRMED', 409);
    const connection = await this.ownedConnection(migration.connectionId, userId);
    if (migration.itemsInitialized === false) await this.initializeItems(migration, connection);
    if (migration.itemsInitialized === false) return { migration, items: [] as SmugMugMigrationItem[], hasMore: true };
    const page = await this.repository.getItemPage(migration.id, 10, migration.resumeAfterRemoteId);
    const items = page.items;
    if (items.some(item => item.migrationId !== migration.id)) throw new SmugMugError('MIGRATION_ITEM_MISMATCH', 409);
    migration.status = 'RUNNING';
    for (const item of items.filter((candidate) => candidate.state === 'PENDING' || (candidate.state === 'FAILED' && candidate.attempts < 3))) {
      await this.requireCurrentConnection(connection);
      item.attempts += 1;
      let checkpoint = true;
      try {
        const scope = migration.inventoryScopeId || connection.id;
        const image = await this.repository.getImage(scope, item.remoteId);
        if (!image || image.remoteId !== item.remoteId) throw new SmugMugError('MIGRATION_IMAGE_MISSING', 409);
        const collections: SmugMugRemoteCollection[] = [];
        const visited = new Set<string>();
        let parent: string | undefined = image.galleryId;
        while (parent) {
          if (visited.has(parent)) throw new SmugMugError('MIGRATION_COLLECTION_CYCLE', 409);
          if (collections.length >= 100) throw new SmugMugError('MIGRATION_COLLECTION_DEPTH', 409);
          visited.add(parent);
          const collection = await this.repository.getCollection(scope, parent);
          // Partial provider inventories may omit an ancestor; preserve the
          // known records and their parent references without inventing a node.
          if (!collection) break;
          if (collection.remoteId !== parent) throw new SmugMugError('MIGRATION_COLLECTION_MISMATCH', 409);
          collections.push(collection);
          parent = collection.parentRemoteId;
        }
        await this.requireCurrentConnection(connection);
        delete item.errorCode;
        await this.sink.importReference({ connectionId: connection.id, creatorId: migration.creatorId, image, collections });
        if (item.requestedQuality === 'EXTERNAL_REFERENCE_ONLY') { item.state = 'REFERENCE_IMPORTED'; continue; }
        await this.requireCurrentConnection(connection);
        const transfer = await this.gateway.download(connection.encryptedCredentialRef!, image);
        await this.requireCurrentConnection(connection);
        if (image.mimeType && transfer.mimeType !== image.mimeType) throw new SmugMugError('MIME_MISMATCH', 422);
        const checksum = createHash('sha256').update(transfer.body).digest('hex');
        const providerChecksum = image.checksum
          ? createHash(image.checksumAlgorithm || (image.checksum.length === 32 ? 'md5' : 'sha256')).update(transfer.body).digest('hex')
          : undefined;
        if (image.checksum && providerChecksum?.toLowerCase() !== image.checksum.toLowerCase()) throw new SmugMugError('CHECKSUM_MISMATCH', 422);
        item.checksum = checksum;
        const existing = await this.sink.findAssetByChecksum(migration.creatorId, checksum, { connectionId: connection.id, image });
        await this.requireCurrentConnection(connection);
        if (existing && this.sink.reuseAsset) {
          await this.sink.reuseAsset({ connectionId: connection.id, creatorId: migration.creatorId, image, assetId: existing, checksum });
          item.canonicalAssetId = existing; item.state = 'DEDUPLICATED'; continue;
        }
        const quarantined = await this.sink.quarantine({ connectionId: connection.id, creatorId: migration.creatorId, image, ...transfer, checksum });
        if (quarantined.scanPassed) item.canonicalAssetId = quarantined.assetId;
        else delete item.canonicalAssetId;
        item.state = quarantined.scanPassed ? 'TRANSFERRED' : 'QUARANTINED';
      } catch (error) {
        if (error instanceof SmugMugAdmissionError) { checkpoint = false; throw error; }
        item.state = 'FAILED';
        item.errorCode = error instanceof SmugMugError ? error.code : 'TRANSFER_FAILED';
        // Validation, permission, and policy failures are deterministic and must
        // not be retried automatically. Only transient gateway failures consume
        // the remaining bounded attempts on a later resume.
        if (error instanceof SmugMugError) item.attempts = 3;
      } finally {
        if (checkpoint) {
          await this.requireCurrentConnection(connection);
          await this.repository.putItem(migration.id, item);
        }
      }
    }
    migration.updatedAt = new Date().toISOString();
    const hasFailures = Boolean(migration.resumeHasFailures) || items.some(item => !['REFERENCE_IMPORTED', 'TRANSFERRED', 'DEDUPLICATED'].includes(item.state));
    if (page.nextAfterRemoteId) {
      if (page.nextAfterRemoteId === migration.resumeAfterRemoteId) throw new SmugMugError('MIGRATION_CURSOR_STALLED', 409);
      migration.resumeAfterRemoteId = page.nextAfterRemoteId;
      migration.resumeHasFailures = hasFailures;
      migration.status = 'RUNNING';
    } else {
      delete migration.resumeAfterRemoteId;
      delete migration.resumeHasFailures;
      migration.status = hasFailures ? 'PARTIAL' : 'COMPLETED';
    }
    await this.requireCurrentConnection(connection);
    await this.repository.putMigration(migration);
    return { migration, items, hasMore: Boolean(page.nextAfterRemoteId) };
  }

  async sync(id: string, userId: string) {
    const result = await this.inventory(id, userId);
    if (!result.complete) return result;
    const connection = await this.ownedConnection(id, userId);
    connection.lastSyncAt = connection.updatedAt = new Date().toISOString();
    await this.repository.putConnection(connection);
    return result;
  }

  async disconnect(id: string, userId: string) {
    const connection = await this.ownedConnection(id, userId, false);
    if (connection.encryptedCredentialRef) await this.gateway.deleteCredential?.(connection.encryptedCredentialRef);
    connection.state = 'DISCONNECTED';
    connection.encryptedCredentialRef = undefined;
    connection.updatedAt = new Date().toISOString();
    await this.repository.putConnection(connection);
  }

  /** Explicit phase-three operation. Inventory, import, sync, and connect never call this. */
  async publishSelected(id: string, userId: string, galleryId: string, workIds: string[]) {
    const connection = await this.ownedConnection(id, userId);
    if (!this.outbound || !this.gateway.publish || !connection.encryptedCredentialRef) throw new SmugMugError('OUTBOUND_PUBLISHING_UNAVAILABLE', 409);
    const gallery = (await this.repository.getCollections(connection.completedInventoryScopeId || id)).find((item) => item.remoteId === galleryId && (item.kind === 'GALLERY' || item.kind === 'ALBUM'));
    if (!gallery?.remoteUri) throw new SmugMugError('SMUGMUG_GALLERY_NOT_PUBLISHABLE', 409);
    const uniqueWorkIds = [...new Set(workIds)].slice(0, 100);
    if (!uniqueWorkIds.length) throw new SmugMugError('WORK_SELECTION_REQUIRED', 400);
    const results: Array<{ workId: string; status: 'published' | 'failed'; remoteId?: string; errorCode?: string }> = [];
    for (const workId of uniqueWorkIds) {
      try {
        const source = await this.outbound.load(connection.creatorId, workId);
        const remote = await this.gateway.publish(connection.encryptedCredentialRef, { galleryUri: gallery.remoteUri, ...source });
        const privacy = String(gallery.privacy.visibility || '').toLowerCase();
        const visibility = privacy === 'public' ? 'public' : privacy === 'unlisted' ? 'unlisted' : 'private';
        await this.outbound.record({ connectionId: id, creatorId: connection.creatorId, workId, ...remote, visibility });
        results.push({ workId, status: 'published', remoteId: remote.remoteId });
      } catch (error) {
        results.push({ workId, status: 'failed', errorCode: error instanceof SmugMugError ? error.code : 'PUBLISH_FAILED' });
      }
    }
    return { connectionId: id, galleryId, results };
  }

  async syncSelectedMetadata(id: string, userId: string, workIds: string[]) {
    const connection = await this.ownedConnection(id, userId);
    if (!this.outbound || !this.gateway.updateMetadata || !connection.encryptedCredentialRef) throw new SmugMugError('METADATA_SYNC_UNAVAILABLE', 409);
    const uniqueWorkIds = [...new Set(workIds)].slice(0, 100);
    if (!uniqueWorkIds.length) throw new SmugMugError('WORK_SELECTION_REQUIRED', 400);
    const results: Array<{ workId: string; status: 'updated' | 'failed'; errorCode?: string }> = [];
    for (const workId of uniqueWorkIds) {
      try {
        const metadata = await this.outbound.loadMetadata(id, connection.creatorId, workId);
        await this.gateway.updateMetadata(connection.encryptedCredentialRef, metadata);
        await this.outbound.recordMetadataSync(id, connection.creatorId, workId);
        results.push({ workId, status: 'updated' });
      } catch (error) {
        results.push({ workId, status: 'failed', errorCode: error instanceof SmugMugError ? error.code : 'METADATA_SYNC_FAILED' });
      }
    }
    return { connectionId: id, results };
  }

  private async ownedMigration(id: string, userId: string, requireConnected = true) {
    const migration = await this.repository.getMigration(id);
    if (!migration) throw new SmugMugError('MIGRATION_NOT_FOUND', 404);
    if (migration.userId !== userId) throw new SmugMugError('MIGRATION_FORBIDDEN', 403);
    const connection = requireConnected ? await this.ownedConnection(migration.connectionId, userId) : await this.inspectConnection(migration.connectionId, userId);
    if (migration.creatorId !== connection.creatorId) throw new SmugMugError('MIGRATION_CONNECTION_MISMATCH', 409);
    return migration;
  }

}

export class SmugMugError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export const validateInventoryCompletion = (connection: SmugMugConnection, expected: SmugMugConnection, migration: SmugMugMigration): void => {
  if (connection.id !== expected.id || connection.userId !== expected.userId || connection.creatorId !== expected.creatorId
    || !expected.inventoryScopeId || !expected.inventoryInProgress || !expected.inventoryPagesComplete || expected.inventoryCursor !== undefined
    || connection.inventoryInProgress !== false || connection.state !== 'INVENTORY_READY'
    || connection.inventoryScopeId !== expected.inventoryScopeId || connection.completedInventoryScopeId !== expected.inventoryScopeId
    || migration.inventoryScopeId !== expected.inventoryScopeId || migration.connectionId !== connection.id
    || migration.userId !== connection.userId || migration.creatorId !== connection.creatorId || migration.status !== 'REVIEW') throw new Error('Inventory completion identity mismatch.');
};

export const validateConnectionCheckpoint = (connection: SmugMugConnection, expected: SmugMugConnection): void => {
  if (connection.id !== expected.id || connection.creatorId !== expected.creatorId || connection.userId !== expected.userId
    || connection.oauthState !== expected.oauthState || connection.accountId !== expected.accountId || connection.encryptedCredentialRef !== expected.encryptedCredentialRef) throw new Error('Connection checkpoint identity mismatch.');
};

export const validateInventoryPageWrite = (expected: SmugMugConnection, collections: SmugMugRemoteCollection[], images: SmugMugRemoteImage[]): void => {
  if (!expected.inventoryInProgress || expected.inventoryPagesComplete || !expected.inventoryScopeId || !['CONNECTED', 'INVENTORY_READY'].includes(expected.state)
    || [...collections, ...images].some(item => !item || typeof item.remoteId !== 'string' || !item.remoteId.trim())) throw new Error('Invalid inventory page write.');
};

class SmugMugAdmissionError extends SmugMugError {}

export const validateSmugMugItemPage = (limit: number, afterRemoteId?: string): void => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (afterRemoteId !== undefined && (typeof afterRemoteId !== 'string' || !afterRemoteId.trim() || afterRemoteId.length > 200))) throw new SmugMugError('INVALID_ITEM_PAGE', 400);
};

/** Legacy pending records without explicit expiry must restart authorization. */
export const isSmugMugOAuthClaimable = (connection: SmugMugConnection, now: number): boolean =>
  Number.isSafeInteger(now) && now >= 0 && connection.state === 'AUTHORIZING'
  && Number.isSafeInteger(connection.oauthExpiresAt) && connection.oauthExpiresAt! > now
  && [connection.id, connection.userId, connection.creatorId, connection.oauthState, connection.encryptedCredentialRef]
    .every(value => typeof value === 'string' && Boolean(value.trim()));
