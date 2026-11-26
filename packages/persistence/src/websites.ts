import { WebsiteError, type Website, type WebsiteDocument, type WebsiteDependency } from '@ubeeq/core';
/** Immutable, workspace-scoped bytes. Implementations own receipts and accounting;
 * logical retention cleanup must not silently refund or remove physical versions. */
export interface WebsiteBlobStore {
  put(workspaceId:string,checksum:string,bytes:Uint8Array):Promise<void>;
  get(workspaceId:string,checksum:string):Promise<Uint8Array|undefined>;
  getRange(workspaceId:string,checksum:string,start:number,end:number):Promise<Uint8Array|undefined>;
}
export interface WebsiteImageRecord {
  id:string;workspaceId:string;revision:number;title:string;mimeType:'image/webp';
  checksum:string;sizeBytes:number;width:number;height:number;
}
export interface WebsiteArtifactManifest {
  digest:string;
  files:Readonly<Record<string,{checksum:string;byteLength:number}>>;
}

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
  setWebsiteShare?(identityId:string,ownerId:string,websiteId:string,enabled:boolean):Promise<void>;
  listWebsiteShares?(identityId:string):Promise<readonly {ownerId:string;websiteId:string}[]>;
  putWebsiteImage?(image:WebsiteImageRecord,bytes:Uint8Array):Promise<void>;
  getWebsiteImage?(workspaceId:string,id:string):Promise<{image:WebsiteImageRecord;bytes:Uint8Array}|undefined>;
  listWebsiteImages?(workspaceId:string):Promise<readonly WebsiteImageRecord[]>;
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
  /** Optional immutable blob access: preview reads do not materialize the archive or unrelated media. */
  getArtifactManifest?(workspaceId:string,digest:string):Promise<WebsiteArtifactManifest|undefined>;
  getArtifactFile?(workspaceId:string,digest:string,path:string):Promise<Uint8Array|undefined>;
  /** Read and integrity-check only the requested byte interval, never the full file/ZIP.
   * start is inclusive and end exclusive; requests contain at most 2 MiB. */
  getArtifactFileRange?(workspaceId:string,digest:string,path:string,start:number,end:number):Promise<Uint8Array|undefined>;
  removeArtifact(workspaceId: string, digest: string): Promise<void>;
}

/** Bind the file projection to its exact stored (uncompressed) ZIP bytes. */
export function verifyWebsiteArtifactProjection(digest:string,zip:Uint8Array,files:ReadonlyMap<string,Uint8Array>,checksum:(bytes:Uint8Array)=>string):void {
  if(checksum(zip)!==digest)throw new WebsiteError('artifact_conflict','Artifact checksum does not match.');
  const view=new DataView(zip.buffer,zip.byteOffset,zip.byteLength),seen=new Set<string>(),decoder=new TextDecoder();let offset=0;
  while(offset+30<=zip.length&&view.getUint32(offset,true)===0x04034b50){
    const size=view.getUint32(offset+18,true),nameLength=view.getUint16(offset+26,true),extra=view.getUint16(offset+28,true),start=offset+30+nameLength+extra,end=start+size;
    const name=decoder.decode(zip.subarray(offset+30,offset+30+nameLength)),bytes=files.get(name);
    if(view.getUint16(offset+8,true)!==0||end>zip.length||seen.has(name)||!bytes||bytes.length!==size||checksum(zip.subarray(start,end))!==checksum(bytes))throw new WebsiteError('artifact_conflict','Artifact files do not match its archive.');
    seen.add(name);offset=end;
  }
  if(seen.size!==files.size||offset+4>zip.length||view.getUint32(offset,true)!==0x02014b50)throw new WebsiteError('artifact_conflict','Artifact archive is incomplete.');
}
