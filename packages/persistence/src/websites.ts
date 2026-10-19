import type { Website, WebsiteDocument, WebsiteDependency } from '@ubeeq/core';

export interface WebsiteBuildRecord {
  id: string; workspaceId: string; websiteId: string; websiteRevision: number;
  actorId: string; revision: number; idempotencyKey: string;
  creatorIdentityId: string;
  state: 'queued' | 'resolving' | 'validating' | 'rendering' | 'packaging' | 'ready' | 'failed' | 'cancelled';
  createdAt: string; expiresAt: string; snapshotDigest?: string; artifactDigest?: string;
  dependencies: readonly WebsiteDependency[]; warnings: readonly string[];
  policyRevision?: string; invalidated?: boolean; errorCode?: string;
  report?: { pages: number; media: number; bytes: number; files: number; checks: readonly string[] };
}
/** CAS writes are atomic. Stores return copies; private artifacts never get a public URL. */
export interface WebsiteStore {
  getWebsite(workspaceId: string, id: string): Promise<Website | undefined>;
  listWebsites(workspaceId: string): Promise<readonly Website[]>;
  saveWebsite(website: Website, expectedRevision: number): Promise<void>;
  /** Irreversible, revision-checked removal; retained builds remain subject to artifact retention. */
  deleteWebsite?(workspaceId: string, id: string, expectedRevision: number): Promise<void>;
  listWorkspaceBuilds?(workspaceId: string): Promise<readonly WebsiteBuildRecord[]>;
  getDocument(workspaceId: string, id: string): Promise<WebsiteDocument | undefined>;
  saveDocument(document: WebsiteDocument, expectedRevision: number): Promise<void>;
  getBuild(workspaceId: string, id: string): Promise<WebsiteBuildRecord | undefined>;
  saveBuild(build: WebsiteBuildRecord, expectedRevision: number): Promise<void>;
  listBuilds(workspaceId: string, websiteId: string): Promise<readonly WebsiteBuildRecord[]>;
  putArtifact(workspaceId: string, digest: string, zip: Uint8Array, files: ReadonlyMap<string, Uint8Array>): Promise<void>;
  getArtifact(workspaceId: string, digest: string): Promise<{ zip: Uint8Array; files: ReadonlyMap<string, Uint8Array> } | undefined>;
  removeArtifact(workspaceId: string, digest: string): Promise<void>;
}
