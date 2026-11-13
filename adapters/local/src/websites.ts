import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { WebsiteError, WEBSITE_PREVIEW_CHUNK_BYTES, type Website, type WebsiteDocument } from '@ubeeq/core';
import type { WebsiteBuildRecord, WebsiteStore, WebsiteImageRecord, WebsiteArtifactManifest, WebsiteBlobStore } from '@ubeeq/persistence';
import { createHash } from 'node:crypto';
import type { WebsiteHostingStore, WebsitePublishPlan, WebsitePublishIntent, WebsiteDeploymentAttempt } from '@ubeeq/persistence';
import type { HostingConnection, WebsiteHostingTarget, HostingDomain } from '@ubeeq/core';

/** Structural connection port keeps Node's newer built-in sqlite declarations
 * out of consuming applications that still compile against Node 20 types. */
export interface WebsiteSqliteConnection {
  exec(sql:string):void; close():void;
  prepare(sql:string):{
    run(...values:(string|number|bigint|Uint8Array|null)[]):{changes:number|bigint};
    get(...values:(string|number|bigint|Uint8Array|null)[]):unknown;
    all(...values:(string|number|bigint|Uint8Array|null)[]):unknown;
  };
}
/** Local durable, workspace-partitioned private website records and immutable artifacts. */
export class SqliteWebsiteStore implements WebsiteStore, WebsiteHostingStore {
  protected readonly db: WebsiteSqliteConnection;
  constructor(path: string, private readonly blobs?: WebsiteBlobStore) {
    if(path!==':memory:') mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS website_records(workspace TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace,kind,id));
      CREATE TABLE IF NOT EXISTS website_artifacts(workspace TEXT NOT NULL,digest TEXT NOT NULL,zip BLOB NOT NULL,files TEXT NOT NULL,PRIMARY KEY(workspace,digest));`);
    this.db.exec('CREATE TABLE IF NOT EXISTS website_renditions(workspace TEXT NOT NULL,source TEXT NOT NULL,bytes BLOB NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,PRIMARY KEY(workspace,source))');
    this.db.exec('CREATE TABLE IF NOT EXISTS website_images(workspace TEXT NOT NULL,id TEXT NOT NULL,metadata TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(workspace,id))');
    this.db.exec('CREATE TABLE IF NOT EXISTS website_hosting_outbox(workspace TEXT NOT NULL,attempt TEXT NOT NULL,PRIMARY KEY(workspace,attempt))');
    this.db.exec(`CREATE TABLE IF NOT EXISTS website_blobs(workspace TEXT NOT NULL,checksum TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(workspace,checksum));
      CREATE TABLE IF NOT EXISTS website_blob_chunks(workspace TEXT NOT NULL,checksum TEXT NOT NULL,offset INTEGER NOT NULL,byte_length INTEGER NOT NULL,chunk_checksum TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(workspace,checksum,offset));
      CREATE TABLE IF NOT EXISTS website_chunked_blobs(workspace TEXT NOT NULL,checksum TEXT NOT NULL,byte_length INTEGER NOT NULL,PRIMARY KEY(workspace,checksum));
      CREATE TABLE IF NOT EXISTS website_artifact_manifests(workspace TEXT NOT NULL,digest TEXT NOT NULL,manifest TEXT NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(workspace,digest));
      CREATE TABLE IF NOT EXISTS website_artifact_files(workspace TEXT NOT NULL,digest TEXT NOT NULL,path TEXT NOT NULL,checksum TEXT NOT NULL,byte_length INTEGER NOT NULL,PRIMARY KEY(workspace,digest,path));
      CREATE INDEX IF NOT EXISTS website_artifact_blob_refs ON website_artifact_files(workspace,checksum);
      CREATE TABLE IF NOT EXISTS website_snapshot_blobs(workspace TEXT NOT NULL,snapshot TEXT NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(workspace,snapshot,checksum));
      CREATE INDEX IF NOT EXISTS website_snapshot_blob_refs ON website_snapshot_blobs(workspace,checksum);
      CREATE TABLE IF NOT EXISTS website_archives(workspace TEXT NOT NULL,digest TEXT NOT NULL,zip BLOB NOT NULL,PRIMARY KEY(workspace,digest));
      CREATE TABLE IF NOT EXISTS website_external_blobs(workspace TEXT NOT NULL,checksum TEXT NOT NULL,byte_length INTEGER NOT NULL,PRIMARY KEY(workspace,checksum));`);
  }
  async setWebsiteShare(identityId:string,ownerId:string,websiteId:string,enabled:boolean){const id=ownerId+':'+websiteId;if(enabled)this.db.prepare('INSERT OR REPLACE INTO website_records(workspace,kind,id,revision,payload) VALUES(?,?,?,?,?)').run(identityId,'share',id,1,JSON.stringify({ownerId,websiteId}));else this.db.prepare('DELETE FROM website_records WHERE workspace=? AND kind=? AND id=?').run(identityId,'share',id);}
  async listWebsiteShares(identityId:string):Promise<readonly {ownerId:string;websiteId:string}[]>{return this.list(identityId,'share');}
  /** Durable one-use OAuth state; the consuming flow validates actor, workspace, installation and expiry. */
  readonly hostingOAuthStates={
    create:async (state:import('@ubeeq/integrations').OAuthAuthorizationState)=>{this.save(state.cellId,'hosting_oauth',{...state,revision:1},0);},
    consume:async (id:string)=>this.atomic(()=>{const rows=this.db.prepare("SELECT workspace,payload FROM website_records WHERE kind='hosting_oauth' AND id=?").all(id) as {workspace:string;payload:string}[];if(rows.length!==1)return undefined;this.db.prepare("DELETE FROM website_records WHERE workspace=? AND kind='hosting_oauth' AND id=?").run(rows[0].workspace,id);return JSON.parse(rows[0].payload) as import('@ubeeq/integrations').OAuthAuthorizationState;})
  };
  close() { this.db.close(); }
  /** Both tokens are required: data_version detects other connections; total_changes detects this writer. */
  cacheRevision():string { return JSON.stringify([this.db.prepare('PRAGMA data_version').get(),this.db.prepare('SELECT total_changes() AS changes').get()]); }
  private checksum(bytes:Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
  private async prepareBlobs(workspace:string,bodies:Iterable<Uint8Array>) {
    const prepared=new Set<string>();if(!this.blobs)return prepared;
    for(const body of bodies){const checksum=this.checksum(body);
      const existing=this.db.prepare('SELECT 1 FROM website_blobs WHERE workspace=? AND checksum=?').get(workspace,checksum);
      if(!existing){await this.blobs.put(workspace,checksum,body);prepared.add(checksum);}
      else if(this.externalBlob(workspace,checksum))prepared.add(checksum);
    }
    return prepared;
  }
  private externalBlob(workspace:string,checksum:string) {
    return this.db.prepare('SELECT byte_length FROM website_external_blobs WHERE workspace=? AND checksum=?').get(workspace,checksum) as {byte_length:number}|undefined;
  }
  private async readBlob(workspace:string,checksum:string):Promise<Uint8Array|undefined> {
    const external=this.externalBlob(workspace,checksum);if(!external)return this.blob(workspace,checksum);
    const bytes=await this.blobs?.get(workspace,checksum);
    if(!bytes||bytes.length!==external.byte_length||this.checksum(bytes)!==checksum)throw new WebsiteError('artifact_unavailable','Owned website bytes are missing or corrupt.');
    return bytes;
  }
  private putBlob(workspace:string,bytes:Uint8Array,prepared?:ReadonlySet<string>,legacy=false):string {
    const checksum=this.checksum(bytes);
    if(legacy&&this.externalBlob(workspace,checksum))return checksum;
    if(this.blobs&&!legacy&&(!this.db.prepare('SELECT 1 FROM website_blobs WHERE workspace=? AND checksum=?').get(workspace,checksum)||this.externalBlob(workspace,checksum))){
      if(!this.db.prepare('SELECT 1 FROM website_blobs WHERE workspace=? AND checksum=?').get(workspace,checksum)){
        if(!prepared?.has(checksum))throw new WebsiteError('revision_conflict','Website byte references changed during storage. Retry the operation.');
        this.db.prepare('INSERT INTO website_external_blobs(workspace,checksum,byte_length) VALUES(?,?,?)').run(workspace,checksum,bytes.length);
        this.db.prepare("INSERT INTO website_blobs(workspace,checksum,bytes) VALUES(?,?,X'')").run(workspace,checksum);
      }
      return checksum;
    }
    if(bytes.length<=WEBSITE_PREVIEW_CHUNK_BYTES){
      this.db.prepare('INSERT OR IGNORE INTO website_blobs(workspace,checksum,bytes) VALUES(?,?,?)').run(workspace,checksum,bytes);
      return checksum;
    }
    if(this.db.prepare('SELECT 1 FROM website_chunked_blobs WHERE workspace=? AND checksum=?').get(workspace,checksum))return checksum;
    this.db.prepare("INSERT OR IGNORE INTO website_blobs(workspace,checksum,bytes) VALUES(?,?,X'')").run(workspace,checksum);
    const put=this.db.prepare('INSERT INTO website_blob_chunks(workspace,checksum,offset,byte_length,chunk_checksum,bytes) VALUES(?,?,?,?,?,?)');
    for(let offset=0;offset<bytes.length;offset+=WEBSITE_PREVIEW_CHUNK_BYTES){
      const chunk=bytes.subarray(offset,offset+WEBSITE_PREVIEW_CHUNK_BYTES);
      put.run(workspace,checksum,offset,chunk.length,this.checksum(chunk),chunk);
    }
    this.db.prepare('INSERT INTO website_chunked_blobs(workspace,checksum,byte_length) VALUES(?,?,?)').run(workspace,checksum,bytes.length);
    this.db.prepare("UPDATE website_blobs SET bytes=X'' WHERE workspace=? AND checksum=?").run(workspace,checksum);
    return checksum;
  }
  private blobChunk(workspace:string,checksum:string,offset:number,size:number):Uint8Array {
    const row=this.db.prepare('SELECT bytes,chunk_checksum,byte_length FROM website_blob_chunks WHERE workspace=? AND checksum=? AND offset=?').get(workspace,checksum,offset) as {bytes:Uint8Array;chunk_checksum:string;byte_length:number}|undefined;
    if(!row||row.byte_length!==size||row.bytes.length!==size||this.checksum(row.bytes)!==row.chunk_checksum)throw new WebsiteError('artifact_unavailable','Immutable website chunk is missing or corrupt.');
    return row.bytes;
  }
  private blob(workspace:string,checksum:string):Uint8Array|undefined {
    const chunked=this.db.prepare('SELECT byte_length FROM website_chunked_blobs WHERE workspace=? AND checksum=?').get(workspace,checksum) as {byte_length:number}|undefined;
    let bytes:Uint8Array;
    if(chunked){
      bytes=new Uint8Array(chunked.byte_length);
      for(let offset=0;offset<bytes.length;offset+=WEBSITE_PREVIEW_CHUNK_BYTES)bytes.set(this.blobChunk(workspace,checksum,offset,Math.min(WEBSITE_PREVIEW_CHUNK_BYTES,bytes.length-offset)),offset);
    }else{
      const row=this.db.prepare('SELECT bytes FROM website_blobs WHERE workspace=? AND checksum=?').get(workspace,checksum) as {bytes:Uint8Array}|undefined;
      if(!row)return undefined;
      bytes=new Uint8Array(row.bytes);
    }
    if(this.checksum(bytes)!==checksum)throw new WebsiteError('artifact_unavailable','Immutable website bytes are corrupt.');
    return bytes;
  }
  async putWebsiteImage(image:WebsiteImageRecord,bytes:Uint8Array) {
    if(image.id!==`website-image-${image.checksum}`||createHash('sha256').update(bytes).digest('hex')!==image.checksum||bytes.length!==image.sizeBytes)throw new WebsiteError('invalid_media','Image integrity check failed.');
    if(this.db.prepare('SELECT 1 FROM website_images WHERE workspace=? AND id=?').get(image.workspaceId,image.id))return;
    const prepared=await this.prepareBlobs(image.workspaceId,[bytes]);
    if(this.checksum(bytes)!==image.checksum)throw new WebsiteError('invalid_media','Website image changed during storage.');
    this.atomic(()=>{if(this.blobs)this.putBlob(image.workspaceId,bytes,prepared);this.db.prepare('INSERT OR IGNORE INTO website_images(workspace,id,metadata,bytes) VALUES(?,?,?,?)').run(image.workspaceId,image.id,JSON.stringify(image),this.blobs?new Uint8Array():bytes);});
  }
  async listWebsiteImages(workspace:string):Promise<WebsiteImageRecord[]> { return (this.db.prepare('SELECT metadata FROM website_images WHERE workspace=? ORDER BY id').all(workspace) as {metadata:string}[]).map(row=>JSON.parse(row.metadata)); }
  async getWebsiteImage(workspace:string,id:string) {
    const row=this.db.prepare('SELECT metadata,bytes FROM website_images WHERE workspace=? AND id=?').get(workspace,id) as {metadata:string;bytes:Uint8Array}|undefined;
    if(!row)return;
    const image=JSON.parse(row.metadata) as WebsiteImageRecord,bytes=row.bytes.length?new Uint8Array(row.bytes):await this.readBlob(workspace,image.checksum);
    if(!bytes||bytes.length!==image.sizeBytes||this.checksum(bytes)!==image.checksum)throw new WebsiteError('invalid_media','Website image is missing or corrupt.');
    return {image,bytes};
  }
  private read<T>(workspace: string,kind: string,id: string): T | undefined {
    const row=this.db.prepare('SELECT payload FROM website_records WHERE workspace=? AND kind=? AND id=?').get(workspace,kind,id) as {payload:string}|undefined;
    return row?JSON.parse(row.payload):undefined;
  }
  private list<T>(workspace:string,kind:string): T[] {
    return (this.db.prepare('SELECT payload FROM website_records WHERE workspace=? AND kind=? ORDER BY id').all(workspace,kind) as {payload:string}[]).map(r=>JSON.parse(r.payload));
  }
  protected save<T extends {id:string;revision:number}>(workspace:string,kind:string,value:T,expected:number) {
    if(!workspace || !value.id || !Number.isSafeInteger(expected) || expected<0 || value.revision!==expected+1) throw new WebsiteError('revision_conflict','Invalid record revision.');
    if(expected===0) {
      const result=this.db.prepare('INSERT OR IGNORE INTO website_records(workspace,kind,id,revision,payload) VALUES(?,?,?,?,?)').run(workspace,kind,value.id,value.revision,JSON.stringify(value));
      if(!result.changes) throw new WebsiteError('revision_conflict','Record already exists.');
    } else {
      const result=this.db.prepare("UPDATE website_records SET revision=?,payload=? WHERE workspace=? AND kind=? AND id=? AND revision=? AND json_extract(payload, '$.deletedAt') IS NULL").run(value.revision,JSON.stringify(value),workspace,kind,value.id,expected);
      if(!result.changes) throw new WebsiteError('revision_conflict','Record changed concurrently.');
    }
  }
  async getWebsite(workspace:string,id:string) { const site=this.read<Website & {deletedAt?:string}>(workspace,'website',id);return site?.deletedAt?undefined:site; }
  async listWebsites(workspace:string) { return this.list<Website & {deletedAt?:string}>(workspace,'website').filter(site=>!site.deletedAt); }
  async saveWebsite(value:Website,expected:number) { this.save(value.workspaceId,'website',value,expected); }
  async deleteWebsite(workspace:string,id:string,expected:number) {
    const site=await this.getWebsite(workspace,id);if(!site)throw new WebsiteError('website_not_found','Website was not found.');
    this.save(workspace,'website',{...site,revision:expected+1,deletedAt:new Date().toISOString()} as Website,expected);
  }
  async listWorkspaceBuilds(workspace:string) { return this.list<WebsiteBuildRecord>(workspace,'build'); }
  async getDocument(workspace:string,id:string) { return this.read<WebsiteDocument>(workspace,'document',id); }
  async saveDocument(value:WebsiteDocument,expected:number) { this.save(value.workspaceId,'document',value,expected); }
  async getBuild(workspace:string,id:string) { return this.read<WebsiteBuildRecord>(workspace,'build',id); }
  async saveBuild(value:WebsiteBuildRecord,expected:number) { this.save(value.workspaceId,'build',value,expected); }
  async listBuilds(workspace:string,websiteId:string) { return this.list<WebsiteBuildRecord>(workspace,'build').filter(b=>b.websiteId===websiteId); }
  async putArtifact(workspace:string,digest:string,zip:Uint8Array,files:ReadonlyMap<string,Uint8Array>) {return this.saveArtifact(workspace,digest,zip,files,false);}
  private async saveArtifact(workspace:string,digest:string,zip:Uint8Array,files:ReadonlyMap<string,Uint8Array>,legacy:boolean) {
    files=new Map(files);
    if(this.checksum(zip)!==digest)throw new WebsiteError('artifact_conflict','Artifact checksum does not match.');
    // Bind the index to the exact stored ZIP once, without rebuilding another archive.
    const archive=Buffer.from(zip.buffer,zip.byteOffset,zip.byteLength),seen=new Set<string>();let offset=0;
    while(offset+30<=archive.length&&archive.readUInt32LE(offset)===0x04034b50){
      const size=archive.readUInt32LE(offset+18),nameLength=archive.readUInt16LE(offset+26),extra=archive.readUInt16LE(offset+28),start=offset+30+nameLength+extra,end=start+size;
      const name=archive.subarray(offset+30,offset+30+nameLength).toString('utf8'),bytes=files.get(name);
      if(archive.readUInt16LE(offset+8)!==0||end>archive.length||seen.has(name)||!bytes||bytes.length!==size||this.checksum(archive.subarray(start,end))!==this.checksum(bytes))throw new WebsiteError('artifact_conflict','Artifact files do not match its archive.');
      seen.add(name);offset=end;
    }
    if(seen.size!==files.size||offset+4>archive.length||archive.readUInt32LE(offset)!==0x02014b50)throw new WebsiteError('artifact_conflict','Artifact archive is incomplete.');
    const expectedFiles=new Map([...files].map(([path,body])=>[path,this.checksum(body)]));
    const oldArchive=this.db.prepare('SELECT zip FROM website_archives WHERE workspace=? AND digest=?').get(workspace,digest) as {zip:Uint8Array}|undefined;
    const useOwned=Boolean(this.blobs&&!legacy);
    const prepared=useOwned?await this.prepareBlobs(workspace,[...files.values(),...(oldArchive?.zip.length?[]:[zip])]):new Set<string>();
    if(this.checksum(zip)!==digest||[...files].some(([path,body])=>this.checksum(body)!==expectedFiles.get(path)))throw new WebsiteError('artifact_conflict','Website artifact changed during storage.');
    this.atomic(()=>{
      const manifest=JSON.stringify(Object.fromEntries([...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,bytes])=>[path,{checksum:this.putBlob(workspace,bytes,prepared,legacy),byteLength:bytes.length}])));
      const old=this.db.prepare('SELECT manifest FROM website_artifact_manifests WHERE workspace=? AND digest=?').get(workspace,digest) as {manifest:string}|undefined;
      if(old&&old.manifest!==manifest)throw new WebsiteError('artifact_conflict','Immutable artifact cannot be replaced.');
      this.db.prepare('INSERT OR IGNORE INTO website_artifact_manifests(workspace,digest,manifest,checksum) VALUES(?,?,?,?)').run(workspace,digest,manifest,this.checksum(Buffer.from(manifest)));
      for(const [path,entry]of Object.entries(JSON.parse(manifest) as WebsiteArtifactManifest['files']))this.db.prepare('INSERT OR IGNORE INTO website_artifact_files(workspace,digest,path,checksum,byte_length) VALUES(?,?,?,?,?)').run(workspace,digest,path,entry.checksum,entry.byteLength);
      const currentArchive=this.db.prepare('SELECT length(zip) AS size FROM website_archives WHERE workspace=? AND digest=?').get(workspace,digest) as {size:number}|undefined;
      if(useOwned&&!currentArchive?.size)this.putBlob(workspace,zip,prepared);
      this.db.prepare('INSERT OR IGNORE INTO website_archives(workspace,digest,zip) VALUES(?,?,?)').run(workspace,digest,useOwned?new Uint8Array():zip);
      this.db.prepare('DELETE FROM website_artifacts WHERE workspace=? AND digest=?').run(workspace,digest);
    });
  }
  async getArtifact(workspace:string,digest:string) {
    const manifest=await this.getArtifactManifest(workspace,digest,false);
    if(manifest){
      const row=this.db.prepare('SELECT zip FROM website_archives WHERE workspace=? AND digest=?').get(workspace,digest) as {zip:Uint8Array}|undefined;
      const zip=row&&(row.zip.length?new Uint8Array(row.zip):await this.readBlob(workspace,digest));
      if(!zip||this.checksum(zip)!==digest)throw new WebsiteError('artifact_unavailable','Immutable website archive is missing or corrupt.');
      const files=new Map<string,Uint8Array>();
      for(const [path,entry]of Object.entries(manifest.files)){const bytes=await this.readBlob(workspace,entry.checksum);if(!bytes||bytes.length!==entry.byteLength)throw new WebsiteError('artifact_unavailable','Immutable website file is missing.');files.set(path,bytes);}
      return {zip,files};
    }
    const row=this.db.prepare('SELECT zip,files FROM website_artifacts WHERE workspace=? AND digest=?').get(workspace,digest) as {zip:Uint8Array;files:string}|undefined;
    return row?{zip:new Uint8Array(row.zip),files:new Map<string,Uint8Array>((JSON.parse(row.files) as [string,string][]).map(([p,b])=>[p,Buffer.from(b,'base64')]))}:undefined;
  }
  async getArtifactManifest(workspace:string,digest:string,migrate=true):Promise<WebsiteArtifactManifest|undefined> {
    const row=this.db.prepare('SELECT manifest,checksum FROM website_artifact_manifests WHERE workspace=? AND digest=?').get(workspace,digest) as {manifest:string;checksum:string}|undefined;
    if(row){if(this.checksum(Buffer.from(row.manifest))!==row.checksum)throw new WebsiteError('artifact_unavailable','Immutable website manifest is corrupt.');return {digest,files:JSON.parse(row.manifest)};}
    // Old installations migrate on first preview. Subsequent reads touch only the requested blob.
    if(migrate){const old=await this.getArtifact(workspace,digest);if(old){await this.saveArtifact(workspace,digest,old.zip,old.files,true);return this.getArtifactManifest(workspace,digest,false);}}
    return undefined;
  }
  async getArtifactFile(workspace:string,digest:string,path:string) {
    const read=()=>this.db.prepare('SELECT checksum,byte_length FROM website_artifact_files WHERE workspace=? AND digest=? AND path=?').get(workspace,digest,path) as {checksum:string;byte_length:number}|undefined;
    let entry=read();if(!entry){await this.getArtifactManifest(workspace,digest);entry=read();}
    if(!entry)return undefined;const bytes=await this.readBlob(workspace,entry.checksum);
    if(!bytes||bytes.length!==entry.byte_length)throw new WebsiteError('artifact_unavailable','Immutable website file is missing.');
    return bytes;
  }
  async getArtifactFileRange(workspace:string,digest:string,path:string,start:number,end:number){
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end-start>WEBSITE_PREVIEW_CHUNK_BYTES)throw new WebsiteError('invalid_range','Invalid preview byte range.');
    const read=()=>this.db.prepare('SELECT checksum,byte_length FROM website_artifact_files WHERE workspace=? AND digest=? AND path=?').get(workspace,digest,path) as {checksum:string;byte_length:number}|undefined;
    let entry=read();if(!entry){await this.getArtifactManifest(workspace,digest);entry=read();}
    if(!entry)return undefined;
    if(end>entry.byte_length)throw new WebsiteError('invalid_range','Preview byte range exceeds its file.');
    if(this.externalBlob(workspace,entry.checksum)){
      const bytes=await this.blobs?.getRange(workspace,entry.checksum,start,end);
      if(!bytes||bytes.length!==end-start)throw new WebsiteError('artifact_unavailable','Owned website range is missing or corrupt.');return bytes;
    }
    if(entry.byte_length<=WEBSITE_PREVIEW_CHUNK_BYTES){
      const bytes=await this.readBlob(workspace,entry.checksum);
      if(!bytes||bytes.length!==entry.byte_length)throw new WebsiteError('artifact_unavailable','Immutable website file is missing.');
      return bytes.slice(start,end);
    }
    let chunked=this.db.prepare('SELECT byte_length FROM website_chunked_blobs WHERE workspace=? AND checksum=?').get(workspace,entry.checksum) as {byte_length:number}|undefined;
    if(!chunked){
      // One-time migration of older indexed blobs. New writes are already chunked,
      // and all subsequent range reads load only the intersecting chunk rows.
      this.atomic(()=>{
        const old=this.blob(workspace,entry!.checksum);
        if(!old||old.length!==entry!.byte_length)throw new WebsiteError('artifact_unavailable','Immutable website file is missing.');
        this.putBlob(workspace,old);
      });
      chunked=this.db.prepare('SELECT byte_length FROM website_chunked_blobs WHERE workspace=? AND checksum=?').get(workspace,entry.checksum) as {byte_length:number}|undefined;
    }
    if(chunked?.byte_length!==entry.byte_length)throw new WebsiteError('artifact_unavailable','Immutable website chunk index is corrupt.');
    const bytes=new Uint8Array(end-start);
    for(let offset=Math.floor(start/WEBSITE_PREVIEW_CHUNK_BYTES)*WEBSITE_PREVIEW_CHUNK_BYTES;offset<end;offset+=WEBSITE_PREVIEW_CHUNK_BYTES){
      const chunk=this.blobChunk(workspace,entry.checksum,offset,Math.min(WEBSITE_PREVIEW_CHUNK_BYTES,entry.byte_length-offset));
      const from=Math.max(start,offset),to=Math.min(end,offset+chunk.length);
      bytes.set(chunk.subarray(from-offset,to-offset),from-start);
    }
    return bytes;
  }
  private pruneUnusedBlobs(workspace:string,limit=100){
    this.db.prepare(`DELETE FROM website_blobs WHERE rowid IN (
      SELECT b.rowid FROM website_blobs b WHERE b.workspace=?
      AND NOT EXISTS(SELECT 1 FROM website_artifact_files f WHERE f.workspace=b.workspace AND f.checksum=b.checksum)
      AND NOT EXISTS(SELECT 1 FROM website_snapshot_blobs s WHERE s.workspace=b.workspace AND s.checksum=b.checksum)
      AND NOT EXISTS(SELECT 1 FROM website_archives a WHERE a.workspace=b.workspace AND a.digest=b.checksum)
      AND NOT EXISTS(SELECT 1 FROM website_images i WHERE i.workspace=b.workspace AND json_extract(i.metadata,'$.checksum')=b.checksum) LIMIT ?)`)
      .run(workspace,limit);
    for(const table of ['website_blob_chunks','website_chunked_blobs','website_external_blobs'])this.db.prepare(`DELETE FROM ${table} WHERE workspace=? AND NOT EXISTS(SELECT 1 FROM website_blobs b WHERE b.workspace=${table}.workspace AND b.checksum=${table}.checksum)`).run(workspace);
  }
  async removeArtifact(workspace:string,digest:string) { this.atomic(()=>{for(const table of ['website_artifacts','website_archives','website_artifact_manifests','website_artifact_files'])this.db.prepare(`DELETE FROM ${table} WHERE workspace=? AND digest=?`).run(workspace,digest);this.pruneUnusedBlobs(workspace);}); }
  async getPublicRendition(workspace:string,source:string) {
    const row=this.db.prepare('SELECT bytes,width,height FROM website_renditions WHERE workspace=? AND source=?').get(workspace,source) as {bytes:Uint8Array;width:number;height:number}|undefined;
    return row?{bytes:new Uint8Array(row.bytes),width:row.width,height:row.height}:undefined;
  }
  async putPublicRendition(workspace:string,source:string,rendition:{bytes:Uint8Array;width:number;height:number}) {
    this.db.prepare('INSERT OR IGNORE INTO website_renditions(workspace,source,bytes,width,height) VALUES(?,?,?,?,?)').run(workspace,source,rendition.bytes,rendition.width,rendition.height);
  }
  private atomic<T>(fn:()=>T):T { this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;} }
  private replace<T extends {id:string;revision:number}>(workspace:string,kind:string,value:T) {
    const result=this.db.prepare('UPDATE website_records SET payload=? WHERE workspace=? AND kind=? AND id=? AND revision=?').run(JSON.stringify(value),workspace,kind,value.id,value.revision);
    if(!result.changes)throw new WebsiteError('revision_conflict','Hosting configuration changed.');
  }
  async getBinding(w:string,id:string){return this.read<import('@ubeeq/core').WebsiteDestinationBinding>(w,'website_binding',id);}
  async saveBinding(binding:import('@ubeeq/core').WebsiteDestinationBinding,expected:number){this.atomic(()=>{const old=this.read<import('@ubeeq/core').WebsiteDestinationBinding>(binding.workspaceId,'website_binding',binding.id);if(old&&old.websiteId!==binding.websiteId)throw new WebsiteError('foreign_reference','Binding cannot move between websites.');this.save(binding.workspaceId,'website_binding',binding,expected);});}
  async listBindings(w:string,site:string){return this.list<import('@ubeeq/core').WebsiteDestinationBinding>(w,'website_binding').filter(b=>b.websiteId===site);}
  async getConnection(w:string,id:string){return this.read<HostingConnection>(w,'hosting_connection',id);}
  async listConnections(w:string){return this.list<HostingConnection>(w,'hosting_connection');}
  async saveConnection(connection:HostingConnection,expected:number){
    this.atomic(()=>{const old=this.read<HostingConnection>(connection.workspaceId,'hosting_connection',connection.id);if(old&&(old.accountId!==connection.accountId||old.family!==connection.family))throw new WebsiteError('account_changed','A different provider account requires a new connection.');this.save(connection.workspaceId,'hosting_connection',connection,expected);});
  }
  async getTarget(w:string,id:string){return this.read<WebsiteHostingTarget>(w,'hosting_target',id);}
  async listTargets(w:string,site:string){return this.list<WebsiteHostingTarget>(w,'hosting_target').filter(t=>t.websiteId===site);}
  async setServingState(w:string,id:string,state:WebsiteHostingTarget['serving'],operatorRequired=false){this.atomic(()=>{const target=this.read<WebsiteHostingTarget>(w,'hosting_target',id);if(!target)throw new WebsiteError('target_not_found','Target was not found.');this.replace(w,'hosting_target',{...target,serving:state,servingRemovalRequired:operatorRequired});});}
  async saveTarget(target:WebsiteHostingTarget,expected:number){this.atomic(()=>{
    const old=this.read<WebsiteHostingTarget>(target.workspaceId,'hosting_target',target.id);
    const rootId=JSON.stringify([target.family,target.accountId,target.remoteId]),owner=this.read<{workspaceId:string;targetId:string}>('_hosting_roots','hosting_root',rootId);if(owner&&(owner.workspaceId!==target.workspaceId||owner.targetId!==target.id))throw new WebsiteError('hosting_root_in_use','This remote site or root is already managed by another destination.');if(!owner)this.save('_hosting_roots','hosting_root',{id:rootId,revision:1,workspaceId:target.workspaceId,targetId:target.id},0);
    if(old&&(old.websiteId!==target.websiteId||old.accountId!==target.accountId||old.remoteId!==target.remoteId||old.connectionId!==target.connectionId||old.adapterId!==target.adapterId))throw new WebsiteError('target_identity_changed','Create a new target for another account, root or remote site.');
    const value=old?{...target,desiredGeneration:old.desiredGeneration,activeGeneration:old.activeGeneration,activeAttemptId:old.activeAttemptId,activeReleaseId:old.activeReleaseId,activeArtifactDigest:old.activeArtifactDigest,serving:old.serving,servingRemovalRequired:old.servingRemovalRequired,lock:old.lock}:target;
    this.save(value.workspaceId,'hosting_target',value,expected);
  });}
  async putPlan(plan:WebsitePublishPlan,snapshot:unknown){
    if(this.read(plan.workspaceId,'publish_plan',plan.id))throw new WebsiteError('revision_conflict','Record already exists.');
    const bodies=new Map<string,Uint8Array>();
    const encoded=JSON.stringify(snapshot,function(key,value){const source=key===''?snapshot:this[key];if(source instanceof Uint8Array){const checksum=createHash('sha256').update(source).digest('hex');bodies.set(checksum,source);return {__websiteBlob:checksum};}return value;});
    const prepared=await this.prepareBlobs(plan.workspaceId,bodies.values());
    if([...bodies].some(([checksum,body])=>this.checksum(body)!==checksum))throw new WebsiteError('invalid_media','Website snapshot changed during storage.');
    this.atomic(()=>{
      this.save(plan.workspaceId,'publish_plan',{...plan,revision:1},0);
      for(const [checksum,body]of bodies){this.putBlob(plan.workspaceId,body,prepared);this.db.prepare('INSERT OR IGNORE INTO website_snapshot_blobs(workspace,snapshot,checksum) VALUES(?,?,?)').run(plan.workspaceId,plan.snapshotReference,checksum);}
      this.save(plan.workspaceId,'publish_snapshot',{id:plan.snapshotReference,revision:1,encoded},0);
    });
  }
  async cleanupUnacceptedPlans(now:string,limit:number){return this.atomic(()=>{
    if(!Number.isFinite(Date.parse(now)))throw new WebsiteError('invalid_retention','Cleanup needs an exact timestamp.');
    const rows=this.db.prepare(`SELECT p.workspace,p.id,p.payload FROM website_records p WHERE p.kind='publish_plan' AND json_extract(p.payload,'$.expiresAt')<=? AND NOT EXISTS(SELECT 1 FROM website_records i WHERE i.workspace=p.workspace AND i.kind='publish_intent' AND json_extract(i.payload,'$.planId')=p.id) LIMIT ?`).all(now,Math.max(1,Math.min(limit,100))) as {workspace:string;id:string;payload:string}[];
    for(const row of rows){const plan=JSON.parse(row.payload) as WebsitePublishPlan;this.db.prepare("DELETE FROM website_records WHERE workspace=? AND kind='publish_snapshot' AND id=?").run(row.workspace,plan.snapshotReference);this.db.prepare('DELETE FROM website_snapshot_blobs WHERE workspace=? AND snapshot=?').run(row.workspace,plan.snapshotReference);this.db.prepare("DELETE FROM website_records WHERE workspace=? AND kind='publish_plan' AND id=?").run(row.workspace,row.id);}
    for(const row of this.db.prepare('SELECT DISTINCT workspace FROM website_blobs').all() as {workspace:string}[])this.pruneUnusedBlobs(row.workspace);
    return rows.length;
  });}
  async getPlan(w:string,id:string){return this.read<WebsitePublishPlan>(w,'publish_plan',id);}
  async getSnapshot(w:string,id:string){
    const row=this.read<{encoded:string}>(w,'publish_snapshot',id);if(!row)return;
    const hydrate=async(value:unknown):Promise<unknown>=>{
      if(!value||typeof value!=='object')return value;
      const object=value as Record<string,unknown>;
      if(Object.keys(object).length===1){
        if(typeof object.__websiteBytes==='string')return new Uint8Array(Buffer.from(object.__websiteBytes,'base64'));
        if(typeof object.__websiteBlob==='string'){const bytes=await this.readBlob(w,object.__websiteBlob);if(!bytes)throw new WebsiteError('snapshot_unavailable','Pinned website media is missing.');return bytes;}
      }
      if(Array.isArray(value)){const result=[];for(const entry of value)result.push(await hydrate(entry));return result;}
      const entries=[];for(const [key,entry]of Object.entries(object))entries.push([key,await hydrate(entry)]);return Object.fromEntries(entries);
    };
    return hydrate(JSON.parse(row.encoded));
  }
  async getIntent(w:string,id:string){return this.read<WebsitePublishIntent>(w,'publish_intent',id);}
  async getAttempt(w:string,id:string){return this.read<WebsiteDeploymentAttempt>(w,'hosting_attempt',id);}
  async listAttempts(w:string,site:string){const ids=new Set(this.list<WebsiteHostingTarget>(w,'hosting_target').filter(t=>t.websiteId===site).map(t=>t.id));return this.list<WebsiteDeploymentAttempt>(w,'hosting_attempt').filter(a=>ids.has(a.targetId));}
  async acceptIntent(input:Parameters<WebsiteHostingStore['acceptIntent']>[0]){return this.atomic(()=>{
    const {intent}=input,existing=this.read<WebsitePublishIntent>(intent.workspaceId,'publish_intent',intent.id);
    if(existing){if(existing.approvalFingerprint!==intent.approvalFingerprint||JSON.stringify(existing.attemptIds)!==JSON.stringify(intent.attemptIds))throw new WebsiteError('idempotency_conflict','Publish key is bound to another approval.');return existing;}
    if(input.plan){const saved=this.read<WebsitePublishPlan>(intent.workspaceId,'publish_plan',input.plan.id);if(!saved||saved.fingerprint!==intent.approvalFingerprint||saved.actorId!==intent.actorId||Date.parse(saved.expiresAt)<=Date.parse(intent.createdAt))throw new WebsiteError('invalid_approval','Publish approval does not match the captured plan.');}
    if(input.plan?.binding){const binding=this.read<import('@ubeeq/core').WebsiteDestinationBinding>(intent.workspaceId,'website_binding',input.plan.binding.id);if(!binding?.enabled||binding.revision!==input.plan.binding.revision)throw new WebsiteError('binding_changed','Publishing binding changed after review.');}
    for(const expected of input.targets){const target=this.read<WebsiteHostingTarget>(intent.workspaceId,'hosting_target',expected.id);if(!target||target.revision!==expected.revision||target.desiredGeneration!==expected.desiredGeneration)throw new WebsiteError('revision_conflict','Target configuration or desired generation changed.');
      const attempt=input.attempts.find(a=>a.targetId===target.id);if(!attempt||attempt.generation!==target.desiredGeneration+1)throw new WebsiteError('generation_conflict','Invalid target generation.');
      if(target.connectionId){const c=this.read<HostingConnection>(intent.workspaceId,'hosting_connection',target.connectionId);if(!c||c.state!=='connected'||c.accountId!==attempt.accountId||c.revision!==attempt.connectionRevision)throw new WebsiteError('reconnect_required','Connection changed before publication acceptance.');}
      this.replace(intent.workspaceId,'hosting_target',{...target,desiredGeneration:attempt.generation});
      this.save(intent.workspaceId,'hosting_attempt',attempt,0);
      this.db.prepare('INSERT INTO website_hosting_outbox(workspace,attempt) VALUES(?,?)').run(intent.workspaceId,attempt.id);
    }
    this.save(intent.workspaceId,'publish_intent',{...intent,revision:1},0);return intent;
  });}
  async pendingOutbox(limit:number){return this.db.prepare('SELECT workspace AS workspaceId,attempt AS attemptId FROM website_hosting_outbox ORDER BY rowid LIMIT ?').all(Math.max(1,Math.min(limit,100))) as {workspaceId:string;attemptId:string}[];}
  async acknowledgeOutbox(w:string,id:string){this.db.prepare('DELETE FROM website_hosting_outbox WHERE workspace=? AND attempt=?').run(w,id);}
  async claim(w:string,targetId:string,attemptId:string,executionId:string){return this.atomic(()=>{
    const t=this.read<WebsiteHostingTarget>(w,'hosting_target',targetId),a=this.read<WebsiteDeploymentAttempt>(w,'hosting_attempt',attemptId);
    if(!t||!a||a.targetId!==t.id)return false;
    if(t.lock&&t.lock.attemptId!==attemptId)return false;
    if(t.lock&&a.activationStarted)return false;
    this.replace(w,'hosting_target',{...t,lock:{attemptId,executionId}});
    this.save(w,'hosting_attempt',{...a,executionId,revision:a.revision+1},a.revision);return true;
  });}
  private owned(w:string,targetId:string,attemptId:string,executionId:string){const t=this.read<WebsiteHostingTarget>(w,'hosting_target',targetId);if(!t||t.lock?.attemptId!==attemptId||t.lock.executionId!==executionId)throw new WebsiteError('writer_fenced','A different execution owns this target.');return t;}
  async assertOwner(w:string,t:string,a:string,e:string){return this.owned(w,t,a,e);}
  async updateAttempt(a:WebsiteDeploymentAttempt,expected:number,e:string){this.atomic(()=>{this.owned(a.workspaceId,a.targetId,a.id,e);this.save(a.workspaceId,'hosting_attempt',a,expected);});}
  async finish(a:WebsiteDeploymentAttempt,expected:number,e:string,outcome?:{releaseId:string;disabled:boolean}){this.atomic(()=>{
    const t=this.owned(a.workspaceId,a.targetId,a.id,e);
    this.save(a.workspaceId,'hosting_attempt',a,expected);
    const keepLock=a.state==='unknown';
    const active=outcome&&a.generation>=t.activeGeneration?{servingRemovalRequired:outcome.disabled?false:!!t.servingRemovalRequired,activeGeneration:a.generation,activeAttemptId:a.id,activeReleaseId:outcome.releaseId,activeArtifactDigest:a.artifactDigest,serving:outcome.disabled?'unpublished' as const:t.serving==='suspended'?'suspended' as const:'active' as const}:{};
    this.replace(a.workspaceId,'hosting_target',{...t,...active,lock:keepLock?t.lock:undefined});
    this.db.prepare('DELETE FROM website_hosting_outbox WHERE workspace=? AND attempt=?').run(a.workspaceId,a.id);
  });}
  async saveDomain(d:HostingDomain,expected:number){this.save(d.workspaceId,'hosting_domain',d,expected);}
  async listDomains(w:string,t:string){return this.list<HostingDomain>(w,'hosting_domain').filter(d=>d.targetId===t);}
}
