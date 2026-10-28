export interface BrowserPolicy { applicationCode?: string; browserExtensionAvailable?: boolean; deviantArtExtensionRichDescriptionEnabled?: boolean }
export interface BrowserSource { provider: 'deviantart'; accountId: string; siteId: string; objectType: 'deviation'; method: 'browser_public_reference' }
export interface BrowserItem { remoteId: string; sourceUrl: string; title: string; publishedAt?: string; observedAt: string; media: 'external_reference' }
export interface BrowserPairing { pairingId: string; userId: string; creatorId: string; profileId: string; applicationCode: string; expiresAt: number }
export interface BrowserStore { get(id: string): any; put(id: string, value: any): void; transaction<T>(fn: () => T): T }
export class SqliteBrowserStore implements BrowserStore { constructor(path: string); get(id: string): any; put(id: string, value: any): void; transaction<T>(fn: () => T): T; close(): void }
export class BrowserExtensionError extends Error { constructor(code: string, status?: number); code: string; status: number }
export interface BrowserJob { id: string; creatorId: string; source: BrowserSource; state: string; revision: number; imported: number; alreadyPresent: number; failed: number; remaining: number; total: number; items: Array<{remoteId: string; state: string; workId?: string}> }
export interface BrowserGallerySetup {
  id: string; externalAccountId: string; account: {username: string; remoteId: string}; creatorId: string;
  name: string; kind: 'premium'; priceCents: number; currency: 'USD'; state: string; expiresAt: number;
  automaticCreationReady: false; nativeConfirmationRequired: true; priceVerified: false; galleryUrl: string;
  gallery?: {remoteId: string; name: string; accessType: 'premium'};
}
export interface BrowserServiceOptions {
  store: BrowserStore; deploymentId: string; policy: () => BrowserPolicy; authorize(userId: string, creatorId: string): Promise<boolean>;
  existing(pairing: BrowserPairing, source: BrowserSource, item: BrowserItem): Promise<boolean>;
  importItem(pairing: BrowserPairing, source: BrowserSource, item: BrowserItem, identity: string, beforeCommit: () => Promise<void>): Promise<{workId: string; alreadyPresent: boolean}>;
  galleryAccounts?(pairing: BrowserPairing): Promise<Array<{id: string; username: string; remoteId: string}>>;
  galleryAccount?(pairing: BrowserPairing, externalAccountId: string): Promise<{username: string; remoteId: string}>;
  galleryCandidates?(pairing: BrowserPairing, setup: BrowserGallerySetup): Promise<Array<{remoteId: string; name: string; accessType: 'premium'}>>;
  verifyGallery?(pairing: BrowserPairing, setup: BrowserGallerySetup, remoteId: string, beforeCommit: () => Promise<void>): Promise<{remoteId: string; name: string}>;
  budget?(pairing: BrowserPairing, source: BrowserSource): Promise<boolean>; now?: () => number;
}
export class BrowserExtensionService {
  constructor(options: BrowserServiceOptions);
  grant(userId: string, creatorId: string): Promise<{ code: string; expiresAt: number; creatorId: string; applicationCode: string }>;
  exchange(code: string, profileId: string): Promise<{ token: string; pairingId: string; creatorId: string; applicationCode: string; expiresAt: number }>;
  pairing(token: string): Promise<BrowserPairing>;
  disconnect(token: string): Promise<void>;
  revoke(userId: string, pairingId: string): Promise<void>;
  listGalleryAccounts(token: string): Promise<any>;
  prepareGallery(token: string, input: any): Promise<BrowserGallerySetup>;
  gallerySetup(token: string, id: string): Promise<BrowserGallerySetup>;
  listGalleryCandidates(token: string, id: string): Promise<any>;
  confirmGallery(token: string, id: string, remoteId: string): Promise<BrowserGallerySetup>;
  preview(token: string, input: any): Promise<any>;
  start(token: string, input: any): Promise<BrowserJob>;
  pause(token: string, id: string, state?: string): BrowserJob;
  get(token: string, id: string): Promise<BrowserJob>;
  control(token: string, id: string, action: string): Promise<BrowserJob>;
  step(token: string, id: string, observedSource: any, profileId: string): Promise<BrowserJob>;
}
export function features(config: BrowserPolicy): {applicationCode: string | null; browserExtensionAvailable: boolean; deviantArtExtensionRichDescriptionEnabled: boolean; deviantArtExtensionRichDescriptionReady: false};
export function filterItems<T extends BrowserItem>(items: T[], filter?: {name?: string; from?: string; to?: string}): T[];
export function remoteKey(source: BrowserSource, remoteId: string): string;
