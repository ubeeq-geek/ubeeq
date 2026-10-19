import { WebsiteError, membershipAllows, websiteRoutes, type Website, type WebsiteDocument, type WebsiteDependency, type WorkspaceMembership, type WebsiteReleaseDecision, type WebsiteCapabilities } from '@ubeeq/core';
import type { WebsiteBuildRecord, WebsiteStore } from '@ubeeq/persistence';
import { buildWebsiteArtifact, validateWebsiteSnapshotBudget, createWebsiteZip, normalizeWebsiteDocument, websiteDigest, websiteFingerprint, type WebsiteSnapshot } from './website-artifact.js';
import { parse, serialize, type DefaultTreeAdapterMap } from 'parse5';

export interface WebsiteActor { actorId: string; workspaceId: string; }
/** All callbacks are trusted server composition. Never accept their output as request data. */
export interface WebsiteServicePorts {
  store: WebsiteStore;
  membership(actor: WebsiteActor): Promise<WorkspaceMembership | undefined>;
  creatorIdentityAllowed(actor: WebsiteActor, creatorIdentityId: string): Promise<boolean>;
  capabilities(actor: WebsiteActor): Promise<WebsiteCapabilities>;
  resolveSnapshot(actor: WebsiteActor, website: Website): Promise<WebsiteSnapshot>;
  evaluateRelease(input: { actor: WebsiteActor; action: 'build' | 'preview' | 'export'; dependencies: readonly WebsiteDependency[]; websiteId: string }): Promise<WebsiteReleaseDecision>;
  /** Recheck pinned source eligibility, actor offboarding and holds; ordinary newer drafts may stay eligible. */
  dependenciesEligible(actor: WebsiteActor, dependencies: readonly WebsiteDependency[]): Promise<boolean>;
  dependenciesCurrent?(actor: WebsiteActor, dependencies: readonly WebsiteDependency[]): Promise<boolean>;
  enqueue(input: { buildId: string; workspaceId: string; actorId: string; idempotencyKey: string }): Promise<void>;
  audit(input: { actor: WebsiteActor; action: string; websiteId: string; buildId?: string; artifactDigest?: string; result: string }): Promise<void>;
  now?: () => Date; retentionSeconds?: number;
}
export class WebsiteService {
  constructor(private readonly ports: WebsiteServicePorts) {
    if (!Number.isSafeInteger(ports.retentionSeconds ?? 604800) || (ports.retentionSeconds ?? 604800) < 1) throw new WebsiteError('invalid_retention','Retention must be positive seconds.');
  }
  private now() { return this.ports.now?.() ?? new Date(); }
  private async authorize(actor: WebsiteActor, operation: 'view' | 'edit' | 'export', resources: readonly string[]) {
    const member=await this.ports.membership(actor);
    if (!actor.actorId || !actor.workspaceId || member?.userId !== actor.actorId || member.workspaceId !== actor.workspaceId || !resources.every(id=>membershipAllows(member,operation,id))) throw new WebsiteError('authorization_denied','Current workspace authority is required.');
    // Public website export is a release operation; manager/personal owner authority is required.
    if(operation==='export' && !['owner','administrator'].includes(member.role)) throw new WebsiteError('authorization_denied','Public website downloads require owner or manager export authority.');
  }
  private async decision(actor: WebsiteActor, action: 'build' | 'preview' | 'export', websiteId: string, deps: readonly WebsiteDependency[]) {
    const decision=await this.ports.evaluateRelease({actor,action,websiteId,dependencies:deps});
    if(decision.decision!=='allow' || !decision.revision || (decision.expiresAt && (!Number.isFinite(Date.parse(decision.expiresAt)) || Date.parse(decision.expiresAt)<=this.now().getTime()))) throw new WebsiteError('release_restricted','Current release policy does not allow this operation.');
    return decision;
  }
  private async viewingMember(actor:WebsiteActor) {
    const member=await this.ports.membership(actor);
    if(!member || member.userId!==actor.actorId || member.workspaceId!==actor.workspaceId || !membershipAllows({...member,resourceIds:undefined},'view')) throw new WebsiteError('authorization_denied','Current workspace membership is required.');
    return member;
  }
  private resources(websiteId:string,deps:readonly WebsiteDependency[]) { return [websiteId,...deps.filter(d=>!['policy','catalogue'].includes(d.kind)).map(d=>d.id)]; }
  async capabilities(actor: WebsiteActor) { await this.viewingMember(actor); return this.ports.capabilities(actor); }
  async list(actor: WebsiteActor) { const member=await this.viewingMember(actor); return (await this.ports.store.listWebsites(actor.workspaceId)).filter(site=>membershipAllows(member,'view',site.id)); }
  async get(actor: WebsiteActor, id: string) {
    await this.authorize(actor,'view',[id]);
    const site=await this.ports.store.getWebsite(actor.workspaceId,id);
    if(!site) throw new WebsiteError('website_not_found','Website was not found.');
    return site;
  }
  async remove(actor:WebsiteActor,id:string,expectedRevision:number) {
    await this.authorize(actor,'export',[id]);
    if(!await this.ports.store.getWebsite(actor.workspaceId,id))return;
    if(!this.ports.store.deleteWebsite)throw new WebsiteError('delete_unavailable','Website deletion is unavailable.');
    await this.ports.store.deleteWebsite(actor.workspaceId,id,expectedRevision);
    await this.ports.audit({actor,action:'website.deleted',websiteId:id,result:'deleted'});
  }
  async save(actor: WebsiteActor, site: Website, expectedRevision: number) {
    const candidate=structuredClone(site);
    if('deletedAt' in candidate)throw new WebsiteError('invalid_website','Website deletion requires the delete operation.');
    await this.authorize(actor,'edit',[candidate.id,...candidate.pages.map(p=>p.documentId)]);
    if(candidate.workspaceId!==actor.workspaceId || candidate.revision!==expectedRevision+1) throw new WebsiteError('revision_conflict','Website workspace or revision does not match.');
    if(!await this.ports.creatorIdentityAllowed(actor,candidate.creatorIdentityId)) throw new WebsiteError('foreign_reference','Publishing identity is outside this workspace.');
    websiteRoutes(candidate);
    for(const page of candidate.pages) {
      const document=await this.ports.store.getDocument(actor.workspaceId,page.documentId);
      if(!document || document.workspaceId!==actor.workspaceId) throw new WebsiteError('missing_document','Save the page document in this workspace first.');
    }
    const old=await this.ports.store.getWebsite(actor.workspaceId,site.id);
    if(old && old.pages.some(p=>!candidate.pages.some(next=>next.id===p.id) && old.pages.some(child=>child.parentId===p.id && candidate.pages.some(next=>next.id===child.id && next.parentId===p.id)))) throw new WebsiteError('parent_has_children','Resolve child pages before removing their parent.');
    await this.ports.store.saveWebsite(candidate,expectedRevision);
    await this.ports.audit({actor,action:'website.saved',websiteId:site.id,result:'saved'});
    return candidate;
  }
  async saveDocument(actor: WebsiteActor, document: WebsiteDocument, expectedRevision: number) {
    await this.authorize(actor,'edit',[document.id]);
    if(document.workspaceId!==actor.workspaceId || document.revision!==expectedRevision+1) throw new WebsiteError('revision_conflict','Document workspace or revision does not match.');
    const normalized=normalizeWebsiteDocument(structuredClone(document));
    await this.ports.store.saveDocument(normalized,expectedRevision);
    return normalized;
  }
  async document(actor: WebsiteActor, id: string) {
    await this.authorize(actor,'view',[id]);
    const document=await this.ports.store.getDocument(actor.workspaceId,id);
    if(!document) throw new WebsiteError('missing_document','Document was not found.');
    const sharedBy=(await this.list(actor)).flatMap(s=>s.pages.filter(p=>p.documentId===id).map(p=>({websiteId:s.id,pageId:p.id,title:p.title})));
    return {document,sharedBy};
  }
  async requestBuild(actor: WebsiteActor, websiteId: string, expectedRevision: number, idempotencyKey: string) {
    await this.authorize(actor,'edit',[websiteId]);
    if(!idempotencyKey?.trim() || idempotencyKey.length>200) throw new WebsiteError('invalid_idempotency_key','A bounded idempotency key is required.');
    const id='website-build-'+websiteFingerprint([actor.workspaceId,websiteId,actor.actorId,idempotencyKey]);
    let build=await this.ports.store.getBuild(actor.workspaceId,id);
    if(build && build.websiteRevision!==expectedRevision) throw new WebsiteError('idempotency_conflict','This key already identifies another website revision.');
    if(!build) {
      const site=await this.get(actor,websiteId), caps=await this.ports.capabilities(actor);
      if(!caps.export) throw new WebsiteError('export_unavailable','Website export is disabled.');
      if(site.revision!==expectedRevision) throw new WebsiteError('revision_conflict','Website changed before the build was requested.');
      await this.decision(actor,'build',websiteId,[{kind:'website',id:site.id,revision:String(site.revision)}]);
      build={id,workspaceId:actor.workspaceId,websiteId,websiteRevision:expectedRevision,actorId:actor.actorId,creatorIdentityId:site.creatorIdentityId,revision:1,idempotencyKey,state:'queued',createdAt:this.now().toISOString(),expiresAt:new Date(this.now().getTime()+(this.ports.retentionSeconds??604800)*1000).toISOString(),dependencies:[],warnings:[]};
      try { await this.ports.store.saveBuild(build,0); }
      catch(error) { const concurrent=await this.ports.store.getBuild(actor.workspaceId,id); if(!concurrent || concurrent.websiteRevision!==expectedRevision) throw error; build=concurrent; }
    }
    if(build.state==='queued') await this.ports.enqueue({buildId:id,workspaceId:actor.workspaceId,actorId:actor.actorId,idempotencyKey:id});
    return build;
  }
  /** Called by the durable job worker; actor and policy are rechecked here. */
  async execute(workspaceId: string, buildId: string) {
    let build=await this.ports.store.getBuild(workspaceId,buildId);
    if(!build) throw new WebsiteError('build_not_found','Build was not found.');
    if(['ready','failed','cancelled'].includes(build.state)) return build;
    const actor={workspaceId,actorId:build.actorId};
    const transition=async (patch: Partial<WebsiteBuildRecord>) => { const next={...build!,...patch,revision:build!.revision+1}; await this.ports.store.saveBuild(next,build!.revision); build=next; };
    // The queue lease serializes execution. CAS also rejects a duplicate concurrent worker.
    await transition({state:'resolving'});
    try {
      if(build.invalidated) throw new WebsiteError('dependency_restricted','This build was invalidated; request a new candidate.');
      await this.authorize(actor,'edit',[build.websiteId]);
      const site=await this.get(actor,build.websiteId), caps=await this.ports.capabilities(actor);
      if(!caps.export) throw new WebsiteError('export_unavailable','Export is disabled.');
      if(site.revision!==build.websiteRevision) throw new WebsiteError('revision_conflict','Requested website revision is no longer current.');
      if(!await this.ports.creatorIdentityAllowed(actor,site.creatorIdentityId)) throw new WebsiteError('foreign_reference','Publishing identity is no longer available in this workspace.');
      const resolved=await this.ports.resolveSnapshot(actor,structuredClone(site));
      validateWebsiteSnapshotBudget(resolved,caps);
      const snapshot=structuredClone(resolved);
      if(websiteFingerprint(snapshot.website)!==websiteFingerprint(site)) throw new WebsiteError('snapshot_changed','Resolver changed the pinned website settings.');
      const deps:WebsiteDependency[]=[{kind:'website',id:site.id,revision:String(site.revision)},...snapshot.dependencies,...snapshot.documents.map(d=>({kind:'document' as const,id:d.id,revision:String(d.revision)})),...snapshot.galleries.map(g=>({kind:'publication' as const,id:g.publicationId,revision:String(g.revision)})),...snapshot.assets.map(a=>({kind:'asset' as const,id:a.id,revision:`${a.revision}:${a.checksum}`}))];
      await this.authorize(actor,'edit',this.resources(site.id,deps));
      const policy=await this.decision(actor,'build',site.id,deps);
      if(!await this.ports.dependenciesEligible(actor,deps)) throw new WebsiteError('dependency_restricted','A build dependency is no longer eligible.');
      await transition({state:'validating',dependencies:deps,policyRevision:policy.revision});
      await transition({state:'rendering'});
      const artifact=buildWebsiteArtifact(snapshot,caps);
      await transition({state:'packaging'});
      // Do not expose a candidate if membership or policy changed during generation.
      await this.authorize(actor,'edit',this.resources(site.id,deps));
      await this.decision(actor,'build',site.id,deps);
      if(!await this.ports.dependenciesEligible(actor,deps)) throw new WebsiteError('dependency_restricted','A dependency changed eligibility during generation.');
      await this.ports.store.putArtifact(workspaceId,artifact.digest,artifact.zip,artifact.files);
      await transition({state:'ready',artifactDigest:artifact.digest,snapshotDigest:artifact.snapshotDigest,dependencies:artifact.dependencies,warnings:artifact.warnings,report:artifact.report});
      await this.ports.audit({actor,action:'website.build',websiteId:site.id,buildId,artifactDigest:artifact.digest,result:'ready'});
    } catch(error) {
      if(build.state==='ready') throw error;
      await transition({state:'failed',errorCode:error instanceof WebsiteError?error.code:'build_failed'});
      await this.ports.audit({actor,action:'website.build',websiteId:build.websiteId,buildId,result:build.errorCode!});
    }
    return build;
  }
  async build(actor: WebsiteActor, buildId: string) {
    const build=await this.ports.store.getBuild(actor.workspaceId,buildId);
    if(!build) throw new WebsiteError('build_not_found','Build was not found.');
    await this.authorize(actor,'view',this.resources(build.websiteId,build.dependencies));
    const current=await this.ports.store.getWebsite(actor.workspaceId,build.websiteId);
    if(!current)throw new WebsiteError('website_not_found','Website was deleted or is unavailable.');
    let stale=current.revision!==build.websiteRevision;
    for(const dep of build.dependencies.filter(d=>d.kind==='document')) {
      if(String((await this.ports.store.getDocument(actor.workspaceId,dep.id))?.revision)!==dep.revision) stale=true;
    }
    if(this.ports.dependenciesCurrent && !await this.ports.dependenciesCurrent(actor,build.dependencies)) stale=true;
    return {...build,stale:stale || !await this.ports.dependenciesEligible(actor,build.dependencies)};
  }
  async builds(actor:WebsiteActor,websiteId:string) {
    await this.get(actor,websiteId);
    return Promise.all([...await this.ports.store.listBuilds(actor.workspaceId,websiteId)].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)).map(b=>this.build(actor,b.id)));
  }
  private async artifact(actor: WebsiteActor, buildId: string, action: 'preview' | 'export') {
    const build=await this.build(actor,buildId);
    await this.authorize(actor,action==='export'?'export':'view',this.resources(build.websiteId,build.dependencies));
    if(!await this.ports.creatorIdentityAllowed(actor,build.creatorIdentityId)) throw new WebsiteError('foreign_reference','Publishing identity is no longer available in this workspace.');
    if(build.state!=='ready' || !build.artifactDigest || build.invalidated) throw new WebsiteError('artifact_unavailable','A ready, eligible immutable artifact is required.');
    if(Date.parse(build.expiresAt)<=this.now().getTime()) throw new WebsiteError('artifact_expired','Build artifact retention has expired.');
    if(action==='export' && !(await this.ports.capabilities(actor)).export) throw new WebsiteError('export_unavailable','Export is disabled.');
    await this.decision(actor,action,build.websiteId,build.dependencies);
    if(!await this.ports.dependenciesEligible(actor,build.dependencies)) throw new WebsiteError('dependency_restricted','This artifact is no longer eligible; build a new candidate.');
    const artifact=await this.ports.store.getArtifact(actor.workspaceId,build.artifactDigest);
    if(!artifact || websiteDigest(artifact.zip)!==build.artifactDigest || websiteDigest(createWebsiteZip(artifact.files))!==build.artifactDigest) throw new WebsiteError('artifact_unavailable','Artifact is missing or corrupt.');
    // Remote/private storage can take time. Revalidate after loading and inspecting bytes.
    await this.authorize(actor,action==='export'?'export':'view',this.resources(build.websiteId,build.dependencies));
    await this.decision(actor,action,build.websiteId,build.dependencies);
    if(!await this.ports.dependenciesEligible(actor,build.dependencies)) throw new WebsiteError('dependency_restricted','Artifact eligibility changed before release.');
    if(action==='export' && !(await this.ports.capabilities(actor)).export) throw new WebsiteError('export_unavailable','Export was disabled before release.');
    const current=await this.ports.store.getBuild(actor.workspaceId,buildId);
    if(!current || current.invalidated || current.state!=='ready' || current.artifactDigest!==build.artifactDigest) throw new WebsiteError('artifact_unavailable','Artifact was invalidated before release.');
    return {build,artifact};
  }
  async export(actor: WebsiteActor, buildId: string) {
    const {build,artifact}=await this.artifact(actor,buildId,'export');
    await this.ports.audit({actor,action:'website.export',websiteId:build.websiteId,buildId,artifactDigest:build.artifactDigest,result:'exported'});
    return {digest:build.artifactDigest!,bytes:artifact.zip};
  }
  async preview(actor: WebsiteActor, buildId: string, file: string) {
    const {artifact}=await this.artifact(actor,buildId,'preview');
    if(file.startsWith('/') || file.includes('\\') || file.split('/').some(p=>!p || p==='.' || p==='..')) throw new WebsiteError('invalid_path','Invalid preview path.');
    const bytes=artifact.files.get(file);
    if(!bytes) throw new WebsiteError('file_not_found','Preview file was not found.');
    return bytes;
  }
  /** Self-contained private preview for a sandboxed srcdoc iframe, with no session-bearing fetches. */
  async previewDocument(actor: WebsiteActor, buildId: string, file = 'index.html') {
    const {artifact}=await this.artifact(actor,buildId,'preview');
    if(!file.endsWith('.html') || !artifact.files.has(file)) throw new WebsiteError('file_not_found','Preview page was not found.');
    const document=parse(Buffer.from(artifact.files.get(file)!).toString('utf8'));
    const pending:DefaultTreeAdapterMap['node'][]=[document];
    const mimes:Record<string,string>={png:'image/png',jpg:'image/jpeg',webp:'image/webp',avif:'image/avif',gif:'image/gif',mp4:'video/mp4',webm:'video/webm',mp3:'audio/mpeg',ogg:'audio/ogg',wav:'audio/wav',pdf:'application/pdf',txt:'text/plain'};
    while(pending.length) {
      const node=pending.pop()!;
      if('attrs' in node) for(const attr of node.attrs) if(['href','src','poster'].includes(attr.name)) {
        const at=attr.value.indexOf('/assets/');
        if(!attr.value.startsWith('/') || at<0) continue;
        const key=attr.value.slice(at+1),bytes=artifact.files.get(key);
        if(!bytes) continue;
        if(key==='assets/theme.css' && node.tagName==='link') {
          node.tagName='style';node.nodeName='style';node.attrs=[];
          node.childNodes=[{nodeName:'#text',value:Buffer.from(bytes).toString('utf8'),parentNode:node}];
        } else {
          const mime=mimes[key.split('.').pop()??''];
          if(mime) attr.value=`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
        }
      }
      if('childNodes' in node) pending.push(...node.childNodes);
    }
    return serialize(document);
  }
  async previewPages(actor:WebsiteActor,buildId:string) {
    const {artifact}=await this.artifact(actor,buildId,'preview');
    return [...artifact.files.keys()].filter(p=>p.endsWith('.html')).sort();
  }
  async invalidate(workspaceId: string, dependency: {kind:WebsiteDependency['kind'];id:string}) {
    for(const site of await this.ports.store.listWebsites(workspaceId)) for(const build of await this.ports.store.listBuilds(workspaceId,site.id)) {
      if(build.dependencies.some(d=>d.kind===dependency.kind && d.id===dependency.id) && !build.invalidated) await this.ports.store.saveBuild({...build,invalidated:true,revision:build.revision+1},build.revision);
    }
  }
}
