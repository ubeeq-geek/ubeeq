import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebsiteError, WEBSITE_PREVIEW_CHUNK_BYTES, type Website, type WebsiteDocument } from '@ubeeq/core';
import { WebsiteService } from '@ubeeq/portability';
import type { WebsiteActor } from '@ubeeq/portability';

/** The normal bearer session resolves the actor; request bodies cannot choose a workspace. */
export const handleWebsiteRequest = async (input: {
  service: WebsiteService; actor: WebsiteActor; request: IncomingMessage; response: ServerResponse;
  url: URL; body: () => Promise<Record<string, unknown>>;
}): Promise<unknown> => {
  const {service,actor,request,response,url}=input, method=request.method??'GET';
  response.setHeader('cache-control','private, no-store');
  response.setHeader('x-content-type-options','nosniff');
  const parts=url.pathname.split('/').filter(Boolean).slice(2);
  if(method==='GET' && parts[0]==='capabilities') return {capabilities:await service.capabilities(actor)};
  if(parts[0]==='documents' && parts[1]) {
    if(method==='GET') return service.document(actor,parts[1]);
    if(method==='PUT') { const b=await input.body(),doc=b.document as WebsiteDocument; if(doc?.id!==parts[1]) throw new WebsiteError('invalid_document','Document ID must match the route.'); return {document:await service.saveDocument(actor,doc,Number(b.expectedRevision))}; }
  }
  if(parts[0]==='builds' && parts[1]) {
    if(method==='GET'&&parts[2]==='preview-file'){
      const path=url.searchParams.get('file')??'',manifest=await service.previewManifest(actor,parts[1]);
      const entry=Object.hasOwn(manifest.files,path)?manifest.files[path]:undefined;
      if(!entry)throw new WebsiteError('file_not_found','Preview file was not found.');
      response.setHeader('accept-ranges','bytes');response.setHeader('etag',`"${entry.checksum}"`);
      const fail=(status:number,code:string,message:string)=>{response.statusCode=status;response.setHeader('content-type','application/json');response.end(JSON.stringify({error:{code,message}}));};
      if(request.headers['if-match']!==`"${entry.checksum}"`){fail(412,'artifact_conflict','Preview file checksum changed.');return;}
      const range=typeof request.headers.range==='string'?/^bytes=(\d*)-(\d*)$/.exec(request.headers.range):null;
      let start=NaN,end=NaN;
      if(range&&(range[1]||range[2])){
        if(!range[1]){const suffix=Number(range[2]);if(Number.isSafeInteger(suffix)&&suffix>0){start=Math.max(0,entry.byteLength-suffix);end=entry.byteLength;}}
        else {start=Number(range[1]);const last=range[2]?Number(range[2]):entry.byteLength-1;if(Number.isSafeInteger(last)&&last<Number.MAX_SAFE_INTEGER)end=Math.min(entry.byteLength,last+1);}
      }
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end-start>WEBSITE_PREVIEW_CHUNK_BYTES){
        response.setHeader('content-range',`bytes */${entry.byteLength}`);fail(416,'invalid_range','Select one byte range of at most 2 MiB.');return;
      }
      const result=await service.previewFileRange(actor,parts[1],path,start,end,entry.checksum);
      response.statusCode=206;response.setHeader('content-type','application/octet-stream');response.setHeader('content-length',result.bytes.length);
      response.setHeader('content-range',`bytes ${start}-${end-1}/${result.byteLength}`);
      response.setHeader('x-website-artifact-digest',result.digest);response.setHeader('x-website-chunk-checksum',result.chunkChecksum);
      response.end(result.bytes);return;
    }
    if(method==='GET'&&parts[2]==='preview-manifest')return service.previewManifest(actor,parts[1]);
    if(method==='POST'&&parts[2]==='preview-files'){
      const body=await input.body(),known=body.knownChecksums;
      if(known!==undefined&&(!known||typeof known!=='object'||Array.isArray(known)))throw new WebsiteError('invalid_path','Invalid preview checksums.');
      const result=await service.previewFiles(actor,parts[1],body.paths as string[],known as Record<string,string>|undefined);
      return {digest:result.digest,files:result.files.map(file=>({path:file.path,checksum:file.checksum,...(file.bytes?{base64:Buffer.from(file.bytes).toString('base64')}:{})}))};
    }
    if(method==='GET' && parts[2]==='preview-site'){const archive=await service.previewArchive(actor,parts[1]);response.setHeader('content-type','application/zip');response.end(archive.bytes);return;}
    if(method==='GET' && parts[2]==='pages') return {pages:await service.previewPages(actor,parts[1])};
    if(method==='GET' && parts.length===2) return {build:await service.build(actor,parts[1])};
    if(method==='GET' && parts[2]==='export') {
      const artifact=await service.export(actor,parts[1]); response.setHeader('content-type','application/zip'); response.setHeader('content-disposition','attachment; filename="website.zip"'); response.setHeader('etag',`"${artifact.digest}"`); response.end(artifact.bytes); return;
    }
    if(method==='GET' && parts[2]==='preview') {
      if(url.searchParams.get('inline')==='1') {
        response.setHeader('content-type','text/html; charset=utf-8');
        response.setHeader('content-security-policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
        response.end(await service.previewDocument(actor,parts[1],url.searchParams.get('file')??'index.html')); return;
      }
      // Authenticated file retrieval. HTML is inert inside a sandboxed blob iframe in the editor.
      const file=url.searchParams.get('file')??'index.html', bytes=await service.preview(actor,parts[1],file);
      const ext=file.split('.').pop()??'';
      const mime:Record<string,string>={html:'text/html; charset=utf-8',css:'text/css',png:'image/png',jpg:'image/jpeg',webp:'image/webp',avif:'image/avif',gif:'image/gif',mp4:'video/mp4',webm:'video/webm',mp3:'audio/mpeg',ogg:'audio/ogg',wav:'audio/wav',pdf:'application/pdf',txt:'text/plain',xml:'application/xml'};
      response.setHeader('content-type',mime[ext]??'application/octet-stream');
      response.setHeader('content-security-policy',"sandbox; default-src 'none'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
      response.end(bytes); return;
    }
  }
  if(method==='GET' && !parts.length) return {websites:await service.list(actor)};
  if(method==='PUT' && parts.length===1) {
    const b=await input.body(),site=b.website as Website;
    if(site?.id!==parts[0]) throw new WebsiteError('invalid_website','Website ID must match the route.');
    return {website:await service.save(actor,site,Number(b.expectedRevision))};
  }
  if(method==='GET' && parts.length===1) return {website:await service.get(actor,parts[0])};
  if(method==='POST' && parts[1]==='builds') { const b=await input.body(); return {build:await service.requestBuild(actor,parts[0],Number(b.expectedRevision),String(b.idempotencyKey??''))}; }
  if(method==='GET' && parts[1]==='builds') return {builds:await service.builds(actor,parts[0],url.searchParams.has('previewRevision')?Number(url.searchParams.get('previewRevision')):undefined)};
  throw new WebsiteError('website_route_not_found','Website operation was not found.');
};
