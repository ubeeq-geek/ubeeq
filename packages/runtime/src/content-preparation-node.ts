import type {CreatorIntakeFactory} from './creator-intake.js';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AuthenticatedSession} from '@ubeeq/auth';
import {ContentPreparationError} from './content-preparations.js';
import {registerContentPreparationRoutes,type ContentPreparationHttpBindings,type ContentPreparationHttpRequest,type ContentPreparationHttpResponse,type ContentPreparationHttpService} from './content-preparation-http.js';

export interface ContentPreparationNodeRequest extends ContentPreparationHttpRequest {
 readonly incoming:IncomingMessage;
 /** Supplied by the core host's verified identity adapter, never identity headers. */
 readonly session:AuthenticatedSession;
}
export type ContentPreparationNodeBindings<S extends ContentPreparationHttpService=ContentPreparationHttpService>=Omit<ContentPreparationHttpBindings<ContentPreparationNodeRequest,ContentPreparationHttpResponse,S>,'actorId'|'basePath'>&{close?():void};
/** The actual host supplies one composition for both request and worker paths. */
export type ContentPreparationRuntimeBindings<S extends ContentPreparationHttpService=ContentPreparationHttpService>=ContentPreparationNodeBindings<S>&{
 /** Optional trusted birth writer for this same retained content composition.
  * Existing Creator migration is a separate fenced operator operation. */
 createCreator?:CreatorIntakeFactory;
 runNextJob(workerId:string):Promise<unknown>;
};
type Route={method:string;pattern:RegExp;parameters:string[];handle:(request:ContentPreparationNodeRequest,response:ContentPreparationHttpResponse)=>Promise<unknown>};
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function responseFor(response:ServerResponse,head:boolean):ContentPreparationHttpResponse {
 const wrapper:ContentPreparationHttpResponse={
  get headersSent(){return response.headersSent;},setHeader:(name,value)=>response.setHeader(name,value),
  status:code=>{response.statusCode=code;return wrapper;},
  json:value=>{response.setHeader('Content-Type','application/json; charset=utf-8');const body=JSON.stringify(value);response.end(head?undefined:body);},
  type:value=>{response.setHeader('Content-Type',value);return wrapper;},
  attachment:filename=>{response.setHeader('Content-Disposition',filename?`attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g,value=>'%'+value.charCodeAt(0).toString(16).toUpperCase())}`:'attachment');return wrapper;},
  send:value=>{response.setHeader('Content-Length',value.byteLength);response.end(head?undefined:value);}
 };return wrapper;
}
async function bodyFor(request:IncomingMessage,limit:number):Promise<Record<string,unknown>> {
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of request){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>limit)throw new ContentPreparationError('invalid_input','This preparation request is too large.',413);chunks.push(bytes);}
 if(!size)return {};
 try{const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('object required');return value as Record<string,unknown>;}
 catch{throw new ContentPreparationError('invalid_input','A JSON object is required.',400);}
}
/** Native paths and the core /studio alias share exactly the same operations.
 * Authentication happens before reading request data or constructing services. */
export function createContentPreparationNodeHandler<S extends ContentPreparationHttpService>(bindings:ContentPreparationNodeBindings<S>,authenticate:(request:IncomingMessage)=>Promise<AuthenticatedSession>,options:{publicBaseUrl:string;maxJsonBodyBytes?:number}) {
 if(typeof authenticate!=='function')throw Error('Content preparation HTTP requires the host verified-session resolver.');
 const limit=options.maxJsonBodyBytes??16*1024*1024;if(!Number.isSafeInteger(limit)||limit<1||limit>128*1024*1024)throw Error('Content preparation request size must be between 1 byte and 128 MiB.');
 const routes:Route[]=[];
 registerContentPreparationRoutes<ContentPreparationNodeRequest,ContentPreparationHttpResponse,S>({register:(method,path,handle)=>{
  const parameters:string[]=[];const expression=path.split('/').map(part=>{if(part.startsWith(':')){parameters.push(part.slice(1));return '([^/]+)';}return escape(part);}).join('/');
  routes.push({method,pattern:new RegExp('^'+expression+'/?$','i'),parameters,handle});
 }},{...bindings,basePath:'/studio/content',actorId:request=>request.session.subject.id});
 return {
  async handle(request:IncomingMessage,response:ServerResponse):Promise<boolean>{
   const url=new URL(request.url??'/',options.publicBaseUrl),path=url.pathname.startsWith('/api/studio/content')?url.pathname.slice(4):url.pathname,method=(request.method??'GET').toLowerCase();
   let selected:Route|undefined,match:RegExpMatchArray|null=null;
   for(const route of routes)if(route.method===(method==='head'?'get':method)){const candidate=path.match(route.pattern);if(candidate){selected=route;match=candidate;break;}}
   if(!selected||!match)return false;
   const transport=responseFor(response,method==='head');
   try{
    const session=await authenticate(request);
    if(!session?.subject||typeof session.subject.id!=='string'||!session.subject.id||!Array.isArray(session.subject.roles)||!Number.isFinite(Date.parse(session.expiresAt))||Date.parse(session.expiresAt)<=Date.now())throw new ContentPreparationError('authentication_invalid','A verified, unexpired creator session is required.',401);
    if(session.subject.accountScope==='customer_account'||session.subject.roles.includes('customer_account'))throw new ContentPreparationError('creator_access_denied','Customer accounts do not have creator access.',403);
    const params:Record<string,string>={};try{selected.parameters.forEach((name,index)=>{params[name]=decodeURIComponent(match![index+1]);});}catch{throw new ContentPreparationError('invalid_input','Choose a valid preparation resource.',400);}
    const query:Record<string,string|string[]>=Object.create(null);for(const [name,value] of url.searchParams){const old=query[name];query[name]=old===undefined?value:Array.isArray(old)?[...old,value]:[old,value];}
    const body=method==='get'||method==='head'?{}:await bodyFor(request,limit);
    await selected.handle({incoming:request,session,query,body,params},transport);return true;
   }catch(error){if(error instanceof ContentPreparationError){if(!response.headersSent)transport.status(error.status).json({code:error.code,message:error.message});return true;}throw error;}
  },
  close:()=>bindings.close?.()
 };
}
