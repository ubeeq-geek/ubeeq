import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { WebsiteError, type HostingCapabilities, type HostingConnection, type HostingDeploymentContext, type HostingOutcome, type WebsiteHostingAdapter, type WebsiteHostingTarget } from '@ubeeq/core';
import type { HostingPublicProbe } from './website-hosting-http.js';

export interface WebsiteSftpSession {
  realpath(path:string):Promise<string>; stat(path:string):Promise<{directory:boolean;symlink:boolean}|undefined>;
  list(path:string):Promise<string[]>; mkdir(path:string):Promise<void>;
  read(path:string):Promise<Uint8Array>; write(path:string,bytes:Uint8Array):Promise<void>;
  rename(from:string,to:string,replacePointer?:boolean):Promise<void>;
  symlink(target:string,path:string):Promise<void>;readlink(path:string):Promise<string>;
  remove(path:string):Promise<void>;rmdir(path:string):Promise<void>;close():Promise<void>;
}
export interface SftpWebsitePorts {
  connect(target:WebsiteHostingTarget,connection:HostingConnection):Promise<WebsiteSftpSession>;
  managedFiles(target:WebsiteHostingTarget):Promise<readonly string[]>;
  probe:HostingPublicProbe;
}
const digest=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const relativeFile=(path:string)=>{if(!path||path.startsWith('/')||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..')||/[\u0000-\u001f]/.test(path))throw new WebsiteError('unsafe_sftp_path','SFTP paths must stay inside the dedicated managed root.');return path;};
/** Protocol only: no exec, shell, local ssh command, rsync, or remote scripts. */
export class SftpWebsiteHostingAdapter implements WebsiteHostingAdapter {
  readonly apiVersion='2' as const;readonly family='sftp' as const;readonly id:string;readonly capabilities:HostingCapabilities;
  constructor(private readonly mode:'pointer'|'in_place',private readonly ports:SftpWebsitePorts){this.id='sftp-'+mode;this.capabilities={provision:false,select:true,staging:mode==='pointer'?'private':'none',activation:mode==='pointer'?'filesystem_pointer':'in_place',propagation:'operator',rollback:'retained_artifact',domains:'operator_managed',redirects:'portable',headers:false,unpublish:'confirmed',maxFiles:20000,maxBytes:512*1024*1024,maxFileBytes:128*1024*1024};}
  private root(t:WebsiteHostingTarget){const root=t.config.root;if(!root||!root.startsWith('/')||root==='/'||posix.normalize(root)!==root||root.includes('\\')||/[\u0000-\u001f]/.test(root))throw new WebsiteError('unsafe_sftp_root','Configure an exact dedicated absolute directory.');return root;}
  private async session(t:WebsiteHostingTarget,c?:HostingConnection){if(!c||c.family!=='sftp'||c.authorization!=='ssh_key'||c.state!=='connected')throw new WebsiteError('reconnect_required','A verified SSH-key connection is required.');return this.ports.connect(t,c);}
  private async owned(s:WebsiteSftpSession,t:WebsiteHostingTarget,adopt=false){const root=this.root(t),st=await s.stat(root);if(!st?.directory||st.symlink||await s.realpath(root)!==root)throw new WebsiteError('unsafe_sftp_root','SFTP root must exist and cannot traverse symlinks.');const marker=posix.join(root,'ubeeq-owner.txt'),existing=await s.stat(marker);if(existing){if(existing.symlink||Buffer.from(await s.read(marker)).toString()!==t.ownershipMarker)throw new WebsiteError('hosting_ownership','Remote ownership marker does not match.');}else if(adopt){if((await s.list(root)).filter(p=>!['.','..'].includes(p)).length&&t.config.adoptExistingRoot!=='confirmed')throw new WebsiteError('hosting_ownership','Confirm management of this existing root before adopting it.');await s.write(marker,Buffer.from(t.ownershipMarker));}else throw new WebsiteError('hosting_ownership','Remote ownership marker is missing.');return root;}
  private async path(s:WebsiteSftpSession,root:string,file:string,create=true){relativeFile(file);let current=root;for(const part of file.split('/').slice(0,-1)){current=posix.join(current,part);const st=await s.stat(current);if(st?.symlink||st&&!st.directory)throw new WebsiteError('unsafe_sftp_path','Refusing to traverse a remote symlink.');if(!st){if(!create)throw new WebsiteError('sftp_partial_release','A managed release directory is missing.');await s.mkdir(current);}}const destination=posix.join(root,file),st=await s.stat(destination);if(st?.symlink||st?.directory)throw new WebsiteError('unsafe_sftp_path','Refusing to replace a symlink or directory with file bytes.');return destination;}
  async validateTarget(t:WebsiteHostingTarget,c?:HostingConnection){if(t.remoteId!==digest(JSON.stringify([t.accountId,t.config.hostname,Number(t.config.port??22),this.root(t)])))throw new WebsiteError('target_identity_changed','SFTP target must retain its approved account, host, port and root identity.');const s=await this.session(t,c);try{const root=await this.owned(s,t,true);if(this.mode==='pointer'){
      if(t.config.stagingProtected!=='confirmed'||t.config.retainedAssetsMapping!=='confirmed')throw new WebsiteError('sftp_server_configuration_required','Pointer mode requires protected staging and a retained-assets server mapping.');
      const area=posix.join(root,'.ubeeq-probe-'+randomUUID());await s.mkdir(area);try{await s.symlink('.',area+'/a');await s.symlink('.',area+'/b');await s.rename(area+'/a',area+'/b',true);if(await s.readlink(area+'/b')!=='.')throw new WebsiteError('atomic_activation_unavailable','Server pointer replacement failed.');}finally{for(const p of ['a','b'])if(await s.stat(area+'/'+p))await s.remove(area+'/'+p);await s.rmdir(area);}
    }}finally{await s.close();}}
  async prepare(c:HostingDeploymentContext){if(this.mode==='in_place')return {data:{profile:'in_place'}};const s=await this.session(c.target,c.connection);try{const root=await this.owned(s,c.target),release=c.artifact!.digest,releaseRoot=posix.join(root,'releases',release);await this.path(s,root,'releases/'+release+'/placeholder');for(const [file,bytes] of c.artifact!.files){const path=await this.path(s,releaseRoot,file),st=await s.stat(path);if(st){if(digest(await s.read(path))!==digest(bytes))throw new WebsiteError('release_drift','Immutable SFTP release differs from the artifact.');}else await s.write(path,bytes);if(/^assets\/[a-f0-9]{64}\.[a-z0-9]+$/.test(file)){const shared=await this.path(s,root,file);if(!await s.stat(shared))await s.write(shared,bytes);else if(digest(await s.read(shared))!==digest(bytes))throw new WebsiteError('asset_drift','Retained SFTP asset changed.');}}return {releaseId:release};}finally{await s.close();}}
  async activate(c:HostingDeploymentContext):Promise<HostingOutcome>{const s=await this.session(c.target,c.connection);try{const root=await this.owned(s,c.target);
      if(this.mode==='pointer'){const current=posix.join(root,'current');if(await s.stat(current)){const previous=await s.readlink(current);if(c.target.activeReleaseId&&previous!=='releases/'+c.target.activeReleaseId)throw new WebsiteError('remote_drift','SFTP serving pointer changed outside Ubeeq.');}const temp=posix.join(root,'.current-'+digest(c.attemptId).slice(0,24));if(await s.stat(temp))await s.remove(temp);await s.symlink('releases/'+c.artifact!.digest,temp);await c.beforeActivation();await s.rename(temp,current,true);}
      else{const entries=[...c.artifact!.files].sort(([a],[b])=>(a==='ubeeq-release.json'?2:a.startsWith('assets/')?0:1)-(b==='ubeeq-release.json'?2:b.startsWith('assets/')?0:1)||a.localeCompare(b));
        for(const [file,bytes] of entries){if(file==='ubeeq-release.json')continue;const path=await this.path(s,root,file),temp=await this.path(s,root,file+'.ubeeq-'+digest(c.attemptId).slice(0,16));await c.beforeActivation();await s.write(temp,bytes);await c.beforeActivation();try{await s.rename(temp,path);}catch(error){if(!await s.stat(path))throw error;await c.beforeActivation();await s.remove(path);await c.beforeActivation();await s.rename(temp,path);}}
        for(const file of await this.ports.managedFiles(c.target)){if(c.artifact!.files.has(file)||/^assets\/[a-f0-9]{64}\.[a-z0-9]+$/.test(file))continue;const path=await this.path(s,root,file);if(await s.stat(path)){await c.beforeActivation();await s.remove(path);}}
        await c.beforeActivation();await s.write(await this.path(s,root,'ubeeq-release.json'),c.artifact!.files.get('ubeeq-release.json')!);
      }
      return {state:'activated',releaseId:c.artifact!.digest,publicUrl:c.target.publicUrl};
    }finally{await s.close();}}
  async reconcile(c:HostingDeploymentContext):Promise<HostingOutcome>{const s=await this.session(c.target,c.connection);try{const root=await this.owned(s,c.target);if(c.operation==='unpublish'){const disabled=this.mode==='pointer'?(await s.readlink(root+'/current')).startsWith('disabled-'):(await this.ports.managedFiles(c.target)).length>0&&!(await Promise.all((await this.ports.managedFiles(c.target)).map(file=>s.stat(root+'/'+relativeFile(file))))).some(Boolean);return disabled?{state:'disabled',releaseId:'disabled-'+c.generation,publicUrl:c.target.publicUrl}:{state:'unknown'};}
      const artifact=c.artifact;if(!artifact)return {state:'unknown'};
      const link=this.mode==='pointer'?await s.readlink(root+'/current'):undefined;if(link&&!/^releases\/[a-f0-9]{64}$/.test(link))throw new WebsiteError('unsafe_sftp_path','Serving pointer escapes managed releases.');
      const base=link?root+'/'+link:root;
      const marker=JSON.parse(Buffer.from(await s.read(base+'/ubeeq-release.json')).toString());if(marker.release!==c.artifact?.marker)return {state:'unknown',reason:'sftp_partial_or_drifted_release'};
      // Standard SFTP has no remote hash extension guarantee; verify bounded file reads instead.
      for(const [file,bytes] of artifact.files){const path=await this.path(s,base,file,false);if(digest(await s.read(path))!==digest(bytes))return {state:'unknown',reason:'sftp_partial_or_drifted_release'};}
      return {state:'activated',releaseId:artifact.digest,publicUrl:c.target.publicUrl};
    }finally{await s.close();}}
  async unpublish(c:HostingDeploymentContext):Promise<HostingOutcome>{const s=await this.session(c.target,c.connection);try{const root=await this.owned(s,c.target);if(this.mode==='pointer'){const id='disabled-'+c.generation;if(!await s.stat(root+'/'+id))await s.mkdir(root+'/'+id);const temp=root+'/.disabled-'+randomUUID();await s.symlink(id,temp);await c.beforeActivation();await s.rename(temp,root+'/current',true);}else for(const file of await this.ports.managedFiles(c.target)){const path=await this.path(s,root,file);if(await s.stat(path)){await c.beforeActivation();await s.remove(path);}}return {state:'disabled',releaseId:'disabled-'+c.generation,publicUrl:c.target.publicUrl};}finally{await s.close();}}
  async verify(c:HostingDeploymentContext,_outcome:HostingOutcome){const associated=await this.reconcile(c),probe=await this.ports.probe(c);return {...probe,associationConfirmed:['activated','disabled'].includes(associated.state)};}
}

/** DNS/outbound authorization is mandatory and supplied by the installation. */
export const connectWebsiteSftp=async(input:{target:WebsiteHostingTarget;credential:{username:string;privateKey:string;passphrase?:string};authorizeHost:(host:string,port:number)=>Promise<string|void>}):Promise<WebsiteSftpSession>=>{
  const {target}=input,host=target.config.hostname,port=Number(target.config.port??22),fingerprint=target.config.hostKeyFingerprint;
  if(!host||!Number.isSafeInteger(port)||port<1||port>65535||!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint??''))throw new WebsiteError('invalid_sftp_connection','Host, port and an independently verified SHA256 host-key fingerprint are required.');
  const approvedAddress=await input.authorizeHost(host,port);const client=new Client();let hostMismatch=false;
  const config:ConnectConfig={host:typeof approvedAddress==='string'?approvedAddress:host,port,username:input.credential.username,privateKey:input.credential.privateKey,passphrase:input.credential.passphrase,readyTimeout:15000,keepaliveInterval:10000,keepaliveCountMax:2,hostVerifier:(key:Buffer)=>{const actual='SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,'');hostMismatch=actual.length!==fingerprint.length||!timingSafeEqual(Buffer.from(actual),Buffer.from(fingerprint));return !hostMismatch;}};
  await new Promise<void>((resolve,reject)=>{client.once('ready',resolve);client.once('error',()=>reject(new WebsiteError(hostMismatch?'host_key_changed':'sftp_connection_failed','SFTP connection failed or the approved host key changed.')));client.connect(config);});
  const sftp=await new Promise<SFTPWrapper>((resolve,reject)=>client.sftp((error,value)=>error?reject(new WebsiteError('sftp_unavailable','Server does not provide SFTP.')):resolve(value)));
  const call=<T>(fn:(cb:(error:Error|undefined|null,value?:T)=>void)=>void)=>new Promise<T>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new WebsiteError('sftp_timeout','SFTP operation timed out.')),30000);fn((error,value)=>{clearTimeout(timeout);error?reject(error):resolve(value!);});});
  return {
    realpath:p=>call<string>(cb=>sftp.realpath(p,cb)),
    stat:async p=>{try{const attrs=await call<import('ssh2').Stats>(cb=>sftp.lstat(p,cb));return {directory:attrs.isDirectory(),symlink:attrs.isSymbolicLink()};}catch(e){if((e as {code?:number}).code===2)return undefined;throw e;}},
    list:async p=>(await call<import('ssh2').FileEntry[]>(cb=>sftp.readdir(p,cb))).map(e=>e.filename),
    mkdir:p=>call<void>(cb=>sftp.mkdir(p,cb)),
    read:async p=>{const stream=sftp.createReadStream(p),chunks:Buffer[]=[];let count=0;const timeout=setTimeout(()=>{stream.destroy(new WebsiteError('sftp_timeout','Remote file read timed out.'));client.destroy();},30000);try{for await(const chunk of stream){const bytes=Buffer.from(chunk);count+=bytes.length;if(count>128*1024*1024){stream.destroy();throw new WebsiteError('sftp_read_limit','Remote verification file exceeds its byte limit.');}chunks.push(bytes);}return Buffer.concat(chunks);}finally{clearTimeout(timeout);}},
    write:async(p,bytes)=>{await new Promise<void>((resolve,reject)=>{const stream=sftp.createWriteStream(p,{flags:'w',mode:0o640});const timeout=setTimeout(()=>{stream.destroy();client.destroy();reject(new WebsiteError('sftp_timeout','Remote file write timed out.'));},30000);stream.on('close',()=>clearTimeout(timeout));stream.on('error',()=>reject(new WebsiteError('sftp_write_failed','Remote file write failed.')));stream.on('close',resolve);stream.end(Buffer.from(bytes));});},
    rename:(a,b,pointer)=>call<void>(cb=>pointer?sftp.ext_openssh_rename(a,b,cb):sftp.rename(a,b,cb)),
    symlink:(target,path)=>call<void>(cb=>sftp.symlink(target,path,cb)),readlink:p=>call<string>(cb=>sftp.readlink(p,cb)),
    remove:p=>call<void>(cb=>sftp.unlink(p,cb)),rmdir:p=>call<void>(cb=>sftp.rmdir(p,cb)),
    close:async()=>{await new Promise<void>(resolve=>{const timeout=setTimeout(resolve,3000);client.once('close',()=>{clearTimeout(timeout);resolve();});client.end();});}
  };
};
