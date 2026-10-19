import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { WebsiteError, type Website, type WebsiteDocument } from '@ubeeq/core';
import type { WebsiteBuildRecord, WebsiteStore, WebsiteImageRecord } from '@ubeeq/persistence';
import { createHash } from 'node:crypto';

/** Local durable, workspace-partitioned private website records and immutable artifacts. */
export class SqliteWebsiteStore implements WebsiteStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if(path!==':memory:') mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS website_records(workspace TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace,kind,id));
      CREATE TABLE IF NOT EXISTS website_artifacts(workspace TEXT NOT NULL,digest TEXT NOT NULL,zip BLOB NOT NULL,files TEXT NOT NULL,PRIMARY KEY(workspace,digest));`);
    this.db.exec('CREATE TABLE IF NOT EXISTS website_renditions(workspace TEXT NOT NULL,source TEXT NOT NULL,bytes BLOB NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,PRIMARY KEY(workspace,source))');
    this.db.exec('CREATE TABLE IF NOT EXISTS website_images(workspace TEXT NOT NULL,id TEXT NOT NULL,metadata TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(workspace,id))');
  }
  async setWebsiteShare(identityId:string,ownerId:string,websiteId:string,enabled:boolean){const id=ownerId+':'+websiteId;if(enabled)this.db.prepare('INSERT OR REPLACE INTO website_records(workspace,kind,id,revision,payload) VALUES(?,?,?,?,?)').run(identityId,'share',id,1,JSON.stringify({ownerId,websiteId}));else this.db.prepare('DELETE FROM website_records WHERE workspace=? AND kind=? AND id=?').run(identityId,'share',id);}
  async listWebsiteShares(identityId:string):Promise<readonly {ownerId:string;websiteId:string}[]>{return this.list(identityId,'share');}
  close() { this.db.close(); }
  async putWebsiteImage(image:WebsiteImageRecord,bytes:Uint8Array) {
    if(image.id!==`website-image-${image.checksum}`||createHash('sha256').update(bytes).digest('hex')!==image.checksum||bytes.length!==image.sizeBytes)throw new WebsiteError('invalid_media','Image integrity check failed.');
    this.db.prepare('INSERT OR IGNORE INTO website_images(workspace,id,metadata,bytes) VALUES(?,?,?,?)').run(image.workspaceId,image.id,JSON.stringify(image),bytes);
  }
  async listWebsiteImages(workspace:string):Promise<WebsiteImageRecord[]> { return (this.db.prepare('SELECT metadata FROM website_images WHERE workspace=? ORDER BY id').all(workspace) as {metadata:string}[]).map(row=>JSON.parse(row.metadata)); }
  async getWebsiteImage(workspace:string,id:string) {
    const row=this.db.prepare('SELECT metadata,bytes FROM website_images WHERE workspace=? AND id=?').get(workspace,id) as {metadata:string;bytes:Uint8Array}|undefined;
    return row?{image:JSON.parse(row.metadata) as WebsiteImageRecord,bytes:new Uint8Array(row.bytes)}:undefined;
  }
  private read<T>(workspace: string,kind: string,id: string): T | undefined {
    const row=this.db.prepare('SELECT payload FROM website_records WHERE workspace=? AND kind=? AND id=?').get(workspace,kind,id) as {payload:string}|undefined;
    return row?JSON.parse(row.payload):undefined;
  }
  private list<T>(workspace:string,kind:string): T[] {
    return (this.db.prepare('SELECT payload FROM website_records WHERE workspace=? AND kind=? ORDER BY id').all(workspace,kind) as {payload:string}[]).map(r=>JSON.parse(r.payload));
  }
  private save(workspace:string,kind:string,value:{id:string;revision:number},expected:number) {
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
  async putArtifact(workspace:string,digest:string,zip:Uint8Array,files:ReadonlyMap<string,Uint8Array>) {
    const serialized=JSON.stringify([...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([p,b])=>[p,Buffer.from(b).toString('base64')]));
    this.db.prepare('INSERT OR IGNORE INTO website_artifacts(workspace,digest,zip,files) VALUES(?,?,?,?)').run(workspace,digest,zip,serialized);
    const stored=await this.getArtifact(workspace,digest);
    if(!stored || !Buffer.from(stored.zip).equals(Buffer.from(zip))) throw new WebsiteError('artifact_conflict','Immutable artifact cannot be replaced.');
  }
  async getArtifact(workspace:string,digest:string) {
    const row=this.db.prepare('SELECT zip,files FROM website_artifacts WHERE workspace=? AND digest=?').get(workspace,digest) as {zip:Uint8Array;files:string}|undefined;
    return row?{zip:new Uint8Array(row.zip),files:new Map<string,Uint8Array>((JSON.parse(row.files) as [string,string][]).map(([p,b])=>[p,Buffer.from(b,'base64')]))}:undefined;
  }
  async removeArtifact(workspace:string,digest:string) { this.db.prepare('DELETE FROM website_artifacts WHERE workspace=? AND digest=?').run(workspace,digest); }
  async getPublicRendition(workspace:string,source:string) {
    const row=this.db.prepare('SELECT bytes,width,height FROM website_renditions WHERE workspace=? AND source=?').get(workspace,source) as {bytes:Uint8Array;width:number;height:number}|undefined;
    return row?{bytes:new Uint8Array(row.bytes),width:row.width,height:row.height}:undefined;
  }
  async putPublicRendition(workspace:string,source:string,rendition:{bytes:Uint8Array;width:number;height:number}) {
    this.db.prepare('INSERT OR IGNORE INTO website_renditions(workspace,source,bytes,width,height) VALUES(?,?,?,?,?)').run(workspace,source,rendition.bytes,rendition.width,rendition.height);
  }
}
