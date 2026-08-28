import { createServer } from "node:http";
import { EXTENSION_API_VERSION, EXTENSION_CONTRACTS } from "@ubeeq/extension-sdk";

const sendJson = (response, status, body) => { response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(body)); };
const sendHtml = (response, html) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data: http: https:" }); response.end(html); };
const apiUrl = (value) => { const url = new URL(value); if (!/^https?:$/.test(url.protocol)) throw new Error("Reference API URL must be HTTP(S)."); return url; };

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ubeeq reference workspace</title>
<style>body{font:16px system-ui,sans-serif;max-width:58rem;margin:2rem auto;padding:0 1rem;color:#17202a}header{border-bottom:1px solid #ccd3da;margin-bottom:2rem}section{border:1px solid #ccd3da;border-radius:.5rem;padding:1rem;margin:1rem 0}label{display:block;margin:.6rem 0}input,button{font:inherit;padding:.45rem}button{cursor:pointer}pre{white-space:pre-wrap;background:#f4f6f7;padding:1rem;overflow:auto}.row{display:flex;gap:.5rem;flex-wrap:wrap}</style></head>
<body><header><h1>Ubeeq reference workspace</h1><p>A plain local interface for the portable reference API. It deliberately contains no product brand, pricing, discovery, or policy rules.</p></header><main>
<section><h2>Sign in</h2><div class="row"><label>Email <input id="email" type="email" value="creator@example.test"></label><label>Password <input id="password" type="password" value="a-safe-local-password"></label></div><button id="signup">Create local account</button> <button id="signin">Sign in</button><p id="identity" role="status"></p></section>
<section><h2>Creator profile and work</h2><div class="row"><label>Handle <input id="handle" value="creator"></label><label>Display name <input id="display" value="Creator"></label></div><button id="createCreator">Create profile</button><div class="row"><label>Work title <input id="title" value="A local work"></label><button id="createWork">Create work</button></div><p id="work" role="status"></p></section>
<section><h2>Upload and publish</h2><label>Image file <input id="file" type="file" accept="image/*"></label><button id="uploadFile">Upload selected file</button> <button id="process">Run local processing job</button> <button id="publish">Publish current work</button><p id="uploadStatus" role="status"></p></section>
<section><h2>Portability</h2><button id="export">Download creator manifest</button><label>Import manifest <input id="importFile" type="file" accept="application/json"></label><button id="validate">Validate import</button> <button id="import">Import manifest</button><p>Manifest imports are metadata-only. Original files require a separate transfer and processing step.</p></section>
<section><h2>Public work</h2><label>Work ID <input id="publicId"></label><button id="viewPublic">View public response</button></section><pre id="output" aria-live="polite">Ready.</pre></main>
<script>
let token=localStorage.getItem('ubeeq.reference.token')||'',workId=localStorage.getItem('ubeeq.reference.work')||'';
const $=id=>document.getElementById(id),out=value=>{$('output').textContent=typeof value==='string'?value:JSON.stringify(value,null,2)},auth=()=>token?{authorization:'Bearer '+token}:{};
const api=async(path,method='GET',body)=>{const response=await fetch('/api'+path,{method,headers:{'content-type':'application/json',...auth()},body:body?JSON.stringify(body):undefined});const value=response.status===204?null:await response.json();if(!response.ok)throw new Error(value.error?.message||'Request failed');return value};
const account=()=>({email:$('email').value,password:$('password').value});
$('signup').onclick=async()=>{try{out(await api('/v1/auth/sign-up','POST',account()))}catch(e){out(e.message)}};
$('signin').onclick=async()=>{try{const result=await api('/v1/auth/sign-in','POST',account());token=result.token;localStorage.setItem('ubeeq.reference.token',token);$('identity').textContent='Signed in.';out(result)}catch(e){out(e.message)}};
$('createCreator').onclick=async()=>{try{out(await api('/v1/creators','POST',{handle:$('handle').value,displayName:$('display').value}))}catch(e){out(e.message)}};
$('createWork').onclick=async()=>{try{const result=await api('/v1/works','POST',{title:$('title').value});workId=result.work.id;localStorage.setItem('ubeeq.reference.work',workId);$('work').textContent='Current work: '+workId;out(result)}catch(e){out(e.message)}};
$('uploadFile').onclick=async()=>{try{if(!workId)throw new Error('Create a Work first.');const file=$('file').files[0];if(!file)throw new Error('Choose an image file.');const bytes=new Uint8Array(await file.arrayBuffer()),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');const upload=await api('/v1/uploads','POST',{workId,mimeType:file.type||'application/octet-stream',byteLength:file.size,checksum:hash});let binary='';bytes.forEach(b=>binary+=String.fromCharCode(b));await api('/v1/uploads/'+upload.upload.uploadId+'/content','PUT',{base64:btoa(binary)});const complete=await api('/v1/uploads/'+upload.upload.uploadId+'/complete','POST',{workId,checksum:hash,byteLength:file.size});$('uploadStatus').textContent='Queued for processing.';out(complete)}catch(e){out(e.message)}};
$('process').onclick=async()=>{try{out(await api('/v1/operations/jobs/run-next','POST',{}))}catch(e){out(e.message)}};
$('publish').onclick=async()=>{try{if(!workId)throw new Error('Create a Work first.');const result=await api('/v1/works/'+workId+'/publications','POST',{destination:'local'});$('publicId').value=workId;out(result)}catch(e){out(e.message)}};
$('export').onclick=async()=>{try{const manifest=await api('/v1/exports/me');const link=Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([JSON.stringify(manifest,null,2)],{type:'application/json'})),download:'ubeeq-creator-export.json'});link.click();URL.revokeObjectURL(link.href);out({checksum:manifest.checksum,secretsExcluded:manifest.secretsExcluded})}catch(e){out(e.message)}};
const readImport=async()=>JSON.parse(await $('importFile').files[0].text());
$('validate').onclick=async()=>{try{out(await api('/v1/imports/validate','POST',{manifest:await readImport()}))}catch(e){out(e.message)}};
$('import').onclick=async()=>{try{out(await api('/v1/imports','POST',{manifest:await readImport(),dryRun:false}))}catch(e){out(e.message)}};
$('viewPublic').onclick=async()=>{try{out(await api('/v1/public/works/'+$('publicId').value))}catch(e){out(e.message)}};
if(workId){$('work').textContent='Current work: '+workId;$('publicId').value=workId}if(token)$('identity').textContent='Saved local session available.';
</script></body></html>`;

export const createReferenceHandler = ({ referenceApiUrl = process.env.UBEEQ_REFERENCE_API_URL || "http://127.0.0.1:4100" } = {}) => {
  const upstream = apiUrl(referenceApiUrl);
  return async (request, response) => {
    const url = new URL(request.url || "/", "http://reference.local");
    if (url.pathname === "/health") return sendJson(response, 200, { status: "ok" });
    if (url.pathname === "/extension-contracts") return sendJson(response, 200, { apiVersion: EXTENSION_API_VERSION, contracts: EXTENSION_CONTRACTS });
    if (url.pathname === "/api-configuration") return sendJson(response, 200, { apiPath: "/api", referenceApiUrl: upstream.origin });
    if (url.pathname.startsWith("/api/")) {
      try {
        const body = await new Promise((resolve, reject) => { const chunks=[]; request.on("data", chunk=>chunks.push(chunk)); request.on("end",()=>resolve(Buffer.concat(chunks))); request.on("error",reject); });
        const target = new URL(url.pathname.slice(4) + url.search, upstream);
        const headers = { "content-type": request.headers["content-type"] || "application/json", ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), ...(request.headers["idempotency-key"] ? { "idempotency-key": request.headers["idempotency-key"] } : {}) };
        const upstreamResponse = await fetch(target, { method: request.method, headers, body: body.length ? body : undefined });
        response.writeHead(upstreamResponse.status, { "content-type": upstreamResponse.headers.get("content-type") || "application/json" }); response.end(Buffer.from(await upstreamResponse.arrayBuffer())); return;
      } catch { return sendJson(response, 502, { error: "reference_api_unavailable" }); }
    }
    if (url.pathname === "/" || url.pathname === "/workspace") return sendHtml(response, page);
    return sendJson(response, 404, { error: "not_found" });
  };
};

export const createReferenceApp = (configuration = {}) => createServer(createReferenceHandler(configuration));
if (import.meta.url === `file://${process.argv[1]}`) { const port = Number(process.env.PORT || 4173); createReferenceApp().listen(port, "127.0.0.1", () => console.log(`Ubeeq reference workspace listening on http://127.0.0.1:${port}`)); }
