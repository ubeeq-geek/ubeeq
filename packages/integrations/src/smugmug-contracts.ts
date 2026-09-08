export interface SmugMugCapabilities {
  inventory: boolean;
  originalDownloads: boolean;
  exif: boolean;
  passwordProtectedGalleries: false;
}

export interface SmugMugRemoteCollection {
  remoteId: string;
  remoteUri?: string;
  kind: 'FOLDER' | 'GALLERY' | 'ALBUM';
  parentRemoteId?: string;
  title: string;
  description?: string;
  position: number;
  privacy: Record<string, unknown>;
}

export interface SmugMugRemoteImage {
  remoteId: string;
  galleryId: string;
  url: string;
  filename?: string;
  title?: string;
  caption?: string;
  keywords: string[];
  capturedAt?: string;
  position: number;
  byteSize?: number;
  width?: number;
  height?: number;
  mimeType?: string;
  checksum?: string;
  checksumAlgorithm?: 'md5' | 'sha256';
  originalAvailable: boolean;
  sourceUrl?: string;
  privacy: Record<string, unknown>;
  licence: Record<string, unknown>;
  exif?: Record<string, unknown>;
}

export interface SmugMugInventoryPage {
  collections: SmugMugRemoteCollection[];
  images: SmugMugRemoteImage[];
  nextCursor?: string;
}

export interface SmugMugGateway {
  startAuthorization(state: string): Promise<{ authorizationUrl: string; credentialRef: string }>;
  completeAuthorization(credentialRef: string, verifier: string): Promise<{
    credentialRef: string;
    accountId: string;
    accountName: string;
    capabilities: SmugMugCapabilities;
  }>;
  inventory(credentialRef: string, cursor?: string): Promise<SmugMugInventoryPage>;
  download(credentialRef: string, image: SmugMugRemoteImage): Promise<{ body: Buffer; mimeType: string }>;
  deleteCredential?(credentialRef: string): Promise<void>;
  publish?(credentialRef: string, input: { galleryUri: string; body: Buffer; filename: string; mimeType: string; title: string; caption?: string; keywords: string[] }): Promise<{ remoteId: string; remoteUrl?: string; remoteUri?: string }>;
  updateMetadata?(credentialRef: string, input: { remoteUri: string; title: string; caption?: string; keywords: string[] }): Promise<void>;
}
