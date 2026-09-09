import type { FlickrManifestPhoto } from './flickr-metadata.js';
import type { observeReconciliationSnapshots } from './index.js';

export type FlickrMigrationMode = 'REFERENCE_IMPORT' | 'SELECTED_SOURCE_MIGRATION' | 'FULL_CATALOGUE_MIGRATION';
export type FlickrRemoteState = 'ACTIVE' | 'REMOTE_CHANGED' | 'MISSING';
export type FlickrTransferStatus = 'NOT_REQUESTED' | 'QUEUED' | 'QUARANTINED' | 'VALIDATED' | 'UNAVAILABLE' | 'FAILED';

export interface FlickrConnection {
  connectionId: string;
  userId: string;
  creatorId: string;
  accountId: string;
  username: string;
  encryptedTokenRef: string;
  scopes: ['read'];
  state: 'CONNECTED' | 'DISCONNECTED';
  capabilities: { inventory: boolean; originals: boolean; exif: boolean };
  ownershipValidatedAt: string;
  lastInventoryAt?: string;
  lastSyncAt?: string;
  createdAt: string;
}

export interface FlickrOAuthRequest {
  requestToken: string;
  encryptedRequestTokenSecret: string;
  userId: string;
  creatorId: string;
  expiresAt: string;
}


export interface FlickrMigrationItem {
  remoteId: string;
  mode: FlickrMigrationMode;
  sourceQuality?: 'original' | 'highest_available';
  transferStatus: FlickrTransferStatus;
  checksumSha256?: string;
  quarantineObjectKey?: string;
  quarantinedMimeType?: string;
  quarantinedSizeBytes?: number;
  scanOutcome?: 'pending' | 'clean' | 'blocked';
  dedupeStatus: 'UNCHECKED' | 'CHECKSUM_MATCH' | 'CREATOR_CONFIRMED_MATCH' | 'UNIQUE';
  retryCount: number;
  nextRetryAt?: string;
  errorCode?: string;
}

export interface FlickrExternalCollection {
  remoteAlbumId: string;
  title: string;
  description?: string;
  orderedRemotePhotoIds: string[];
  mappedCollectionId?: string;
  reconciliation?: ReturnType<typeof observeReconciliationSnapshots>;
}

export interface FlickrPublication {
  remotePhotoId: string;
  workId: string;
  visibilitySnapshot: FlickrManifestPhoto['visibility'];
  licenceSnapshot?: string;
  metadataHash: string;
  state: FlickrRemoteState;
  lastSyncAt: string;
}

export interface FlickrProvenance {
  remotePhotoId: string;
  /** Kept in the private integration record and removed from browser projections. */
  sourceUrl: string;
  accountId: string;
  originalFilename?: string;
  licenceSnapshot?: string;
  importedAt: string;
  creatorAttestedOwnership: true;
}

export interface FlickrMigration {
  migrationId: string;
  connectionId: string;
  userId: string;
  status: 'INVENTORY_READY' | 'CONFIRMED' | 'RUNNING' | 'REVIEW' | 'COMPLETE';
  cursor?: string;
  /** Next source item to inspect; reset to zero after each full sweep. */
  sourceCursor?: number;
  mode?: FlickrMigrationMode;
  confirmedAt?: string;
  storageConfirmed: boolean;
  discoveryEnabled: false;
  photos: FlickrManifestPhoto[];
  albums: FlickrExternalCollection[];
  publications: FlickrPublication[];
  provenance: FlickrProvenance[];
  items: FlickrMigrationItem[];
  estimatedBytes?: number;
  auditEvents: Array<{
    eventId: string;
    action: 'INVENTORY_CAPTURED' | 'MIGRATION_CONFIRMED' | 'SOURCE_TRANSFERRED' | 'SOURCE_UNAVAILABLE' | 'SOURCE_FAILED';
    remoteId?: string;
    occurredAt: string;
    details?: Record<string, string | number | boolean>;
  }>;
  createdAt: string;
  updatedAt: string;
}

/** Repository boundary is intentionally portable; production adapters can use the core table. */
export interface FlickrRepository {
  putConnection(value: FlickrConnection): Promise<void>;
  getConnection(id: string): Promise<FlickrConnection | undefined>;
  putMigration(value: FlickrMigration): Promise<void>;
  getMigration(id: string): Promise<FlickrMigration | undefined>;
  getMigrationByConnection(connectionId: string): Promise<FlickrMigration | undefined>;
  putOAuthRequest(value: FlickrOAuthRequest): Promise<void>;
  takeOAuthRequest(requestToken: string, userId: string, creatorId: string): Promise<FlickrOAuthRequest | undefined>;
}

export class InMemoryFlickrRepository implements FlickrRepository {
  private connections = new Map<string, FlickrConnection>();
  private migrations = new Map<string, FlickrMigration>();
  private oauthRequests = new Map<string, FlickrOAuthRequest>();
  async putConnection(value: FlickrConnection) { this.connections.set(value.connectionId, structuredClone(value)); }
  async getConnection(id: string) { const value = this.connections.get(id); return value && structuredClone(value); }
  async putMigration(value: FlickrMigration) { this.migrations.set(value.migrationId, structuredClone(value)); }
  async getMigration(id: string) { const value = this.migrations.get(id); return value && structuredClone(value); }
  async getMigrationByConnection(connectionId: string) {
    const value = [...this.migrations.values()].find((migration) => migration.connectionId === connectionId);
    return value && structuredClone(value);
  }
  async putOAuthRequest(value: FlickrOAuthRequest) { this.oauthRequests.set(value.requestToken, structuredClone(value)); }
  async takeOAuthRequest(requestToken: string, userId: string, creatorId: string) {
    const value = this.oauthRequests.get(requestToken);
    if (!value || value.userId !== userId || value.creatorId !== creatorId) return undefined;
    this.oauthRequests.delete(requestToken);
    return value && structuredClone(value);
  }
}
