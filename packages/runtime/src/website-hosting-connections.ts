import type { WebsiteHostingConnections,NetlifyWebsiteHostingAdapter,CloudflarePagesWebsiteHostingAdapter } from '@ubeeq/integrations';
import type { WebsiteHostingStore } from '@ubeeq/persistence';
import { WebsiteError, type WebsiteHostingAdapter } from '@ubeeq/core';
import type { WebsitePublishingService,WebsiteActor } from '@ubeeq/portability';
import { createHash,randomUUID } from 'node:crypto';
export async function handleHostingConnectionRequest(input:{actor:WebsiteActor;service:WebsiteHostingConnections;store:WebsiteHostingStore;publishing:WebsitePublishingService;adapters:readonly WebsiteHostingAdapter[];parts:string[];method:string;body:()=>Promise<Record<string,unknown>>}){
  const {actor,service,store,publishing,parts,method}=input;
  if(method==='GET'&&!parts[1])return {connections:await service.list(actor)};
  const b=method==='GET'?{}:await input.body();
  if(method==='POST'&&parts[1]==='netlify-authorize')return service.beginNetlify(actor,String(b.accountId??''),typeof b.connectionId==='string'?b.connectionId:undefined);
  if(method==='POST'&&parts[1]==='netlify-callback')return {connection:await service.completeNetlify(actor,String(b.state??''),String(b.accessToken??''))};
  if(method==='POST'&&parts[1]==='cloudflare-pages')return {connection:await service.connectPages(actor,{accountId:String(b.accountId??''),token:String(b.token??''),id:typeof b.connectionId==='string'?b.connectionId:undefined})};
  if(method==='POST'&&parts[1]==='sftp')return {connection:await service.connectSftp(actor,{accountId:String(b.accountId??''),username:String(b.username??''),privateKey:String(b.privateKey??''),passphrase:typeof b.passphrase==='string'?b.passphrase:undefined,id:typeof b.connectionId==='string'?b.connectionId:undefined})};
  if(method==='POST'&&parts[1]==='disconnect'){await service.disconnect(actor,String(b.connectionId));return {disconnected:true};}
  // list() enforces management authority before raw server connection lookup.
  await service.list(actor);const connection=await store.getConnection(actor.workspaceId,String(b.connectionId??''));if(!connection)throw new WebsiteError('connection_not_found','Select an existing hosting connection.');
  const adapter=input.adapters.find(a=>a.family===connection.family&&(a.id===b.adapterId||!b.adapterId));if(!adapter)throw new WebsiteError('hosting_unavailable','Hosting adapter is not enabled.');
  if(method==='POST'&&parts[1]==='catalogue'){
    if(adapter.family==='netlify'){const a=adapter as NetlifyWebsiteHostingAdapter,sites=await a.sites(connection,Number(b.page??1));return {sites:sites.filter((s:any)=>s.account_id===connection.accountId).map((s:any)=>({id:s.id,name:s.name,publicUrl:s.ssl_url,gitConnected:Boolean(s.build_settings?.repo_url)}))};}
    if(adapter.family==='cloudflare-pages'){const projects=await (adapter as CloudflarePagesWebsiteHostingAdapter).projects(connection);return {sites:projects.map((p:any)=>({id:p.id,name:p.name,publicUrl:'https://'+p.subdomain+'/',gitConnected:Boolean(p.source),productionBranch:p.production_branch}))};}
  }
  if(method==='POST'&&parts[1]==='provision'){
    if(adapter.family==='netlify'){const accounts=await (adapter as NetlifyWebsiteHostingAdapter).accounts(connection),account=accounts.find((a:any)=>a.id===connection.accountId);if(!account)throw new WebsiteError('account_changed','Selected account is unavailable.');const s=await (adapter as NetlifyWebsiteHostingAdapter).createSite(connection,{accountSlug:account.slug,name:String(b.name??'')});return {site:{id:s.id,name:s.name,publicUrl:s.ssl_url}};}
    if(adapter.family==='cloudflare-pages'){const p=await (adapter as CloudflarePagesWebsiteHostingAdapter).createProject(connection,String(b.name??''));return {site:{id:p.id,name:p.name,publicUrl:'https://'+p.subdomain+'/',productionBranch:p.production_branch}};}
  }
  if(method==='POST'&&parts[1]==='target'){
    const config=(b.config&&typeof b.config==='object'&&!Array.isArray(b.config)?b.config:{}) as Record<string,string>;
    if(Object.values(config).some(v=>typeof v!=='string'))throw new WebsiteError('invalid_target','Target configuration values must be strings.');
    const remoteId=adapter.family==='sftp'?createHash('sha256').update(JSON.stringify([connection.accountId,config.hostname,Number(config.port??22),config.root])).digest('hex'):String(b.remoteId??'');
    const publicUrl=String(b.publicUrl??'');return {target:await publishing.configureTarget(actor,{id:randomUUID(),workspaceId:actor.workspaceId,websiteId:String(b.websiteId??''),revision:1,label:String(b.label??''),adapterId:adapter.id,family:adapter.family,connectionId:connection.id,accountId:connection.accountId,remoteId,publicUrl,basePath:decodeURIComponent(new URL(publicUrl).pathname),config,ownershipConfirmed:b.ownershipConfirmed===true},0)};
  }
  throw new WebsiteError('website_route_not_found','Hosting connection operation was not found.');
}
