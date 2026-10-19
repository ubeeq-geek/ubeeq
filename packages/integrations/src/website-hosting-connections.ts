import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { WebsiteError, type HostingConnection } from '@ubeeq/core';
import type { CredentialVault, OAuthStateStore, OAuthAuthorizationState } from './index.js';
import { HostingHttp, type HostingFetch } from './website-hosting-http.js';
export interface HostingConnectionActor {workspaceId:string;actorId:string;}
export interface WebsiteHostingConnectionPorts {
  cellId:string;vault:CredentialVault;states:OAuthStateStore;
  authorize(actor:HostingConnectionActor):Promise<void>;
  get(workspaceId:string,id:string):Promise<HostingConnection|undefined>;
  list(workspaceId:string):Promise<readonly HostingConnection[]>;
  save(connection:HostingConnection,expected:number):Promise<void>;
  netlify?:{clientId:string;redirectUri:string};fetch?:HostingFetch;
}
interface HostingOAuthState extends OAuthAuthorizationState {workspaceId:string;actorId:string;accountId:string;connectionId?:string;}
const owner=(a:HostingConnectionActor)=>createHash('sha256').update(JSON.stringify([a.workspaceId,a.actorId])).digest('hex');
/** Connection authority is separate from publishing/export. Secrets only enter the encrypted vault. */
export class WebsiteHostingConnections {
  constructor(private readonly ports:WebsiteHostingConnectionPorts){}
  async list(a:HostingConnectionActor){await this.ports.authorize(a);return (await this.ports.list(a.workspaceId)).map(({credentialReference,...c})=>c);}
  async credential(c:HostingConnection){if(!c.credentialReference||c.state!=='connected')throw new WebsiteError('reconnect_required','Reconnect this hosting account.');const value=await this.ports.vault.read({cellId:this.ports.cellId,reference:c.credentialReference});if(!value)throw new WebsiteError('reconnect_required','Hosting credentials expired or were revoked.');return Buffer.from(value).toString();}
  private async save(a:HostingConnectionActor,input:{id?:string;family:HostingConnection['family'];accountId:string;authorization:HostingConnection['authorization'];secret:string}){
    await this.ports.authorize(a);const old=input.id?await this.ports.get(a.workspaceId,input.id):undefined;
    if(input.id&&!old)throw new WebsiteError('connection_not_found','Connection was not found.');
    if(old&&(old.accountId!==input.accountId||old.family!==input.family))throw new WebsiteError('account_changed','Reconnect the same account or create a new connection.');
    const id=old?.id??randomUUID(),stored=await this.ports.vault.write({cellId:this.ports.cellId,ownerId:a.workspaceId,value:Buffer.from(input.secret)});
    const connection:HostingConnection={id,workspaceId:a.workspaceId,revision:(old?.revision??0)+1,family:input.family,accountId:input.accountId,authorization:input.authorization,credentialReference:stored.reference,state:'connected',permissions:['website.deploy']};
    try{await this.ports.save(connection,old?.revision??0);}catch(error){await this.ports.vault.revoke({cellId:this.ports.cellId,reference:stored.reference});throw error;}
    if(old?.credentialReference)await this.ports.vault.revoke({cellId:this.ports.cellId,reference:old.credentialReference});
    const {credentialReference,...safe}=connection;return safe;
  }
  async beginNetlify(a:HostingConnectionActor,accountId:string,connectionId?:string){
    await this.ports.authorize(a);const app=this.ports.netlify;if(!app||new URL(app.redirectUri).protocol!=='https:')throw new WebsiteError('oauth_unavailable','Register a Netlify OAuth application and exact HTTPS callback.');
    if(!accountId||accountId.length>200)throw new WebsiteError('invalid_account','Select the exact Netlify team account ID.');
    const state=randomBytes(32).toString('base64url');const authorizationState:HostingOAuthState={id:state,integrationId:'netlify-hosting',cellId:this.ports.cellId,ownerId:owner(a),redirectUri:app.redirectUri,requiredScopes:[],workspaceId:a.workspaceId,actorId:a.actorId,accountId,connectionId,expiresAt:new Date(Date.now()+600000).toISOString()};await this.ports.states.create(authorizationState);
    const url=new URL('https://app.netlify.com/authorize');url.search=new URLSearchParams({client_id:app.clientId,response_type:'token',redirect_uri:app.redirectUri,state}).toString();return {authorizationUrl:url.href};
  }
  /** Netlify's documented implicit grant: a callback bridge strips the URL fragment before forwarding it. No PAT flow. */
  async completeNetlify(a:HostingConnectionActor,stateId:string,accessToken:string){
    await this.ports.authorize(a);const state=await this.ports.states.consume(stateId) as HostingOAuthState|undefined;
    if(!state||state.ownerId!==owner(a)||state.workspaceId!==a.workspaceId||state.actorId!==a.actorId||state.cellId!==this.ports.cellId||state.integrationId!=='netlify-hosting'||state.redirectUri!==this.ports.netlify?.redirectUri||Date.parse(state.expiresAt)<=Date.now())throw new WebsiteError('invalid_oauth_state','OAuth state is expired, used, or belongs to another actor/installation.');
    if(!accessToken||accessToken.length>8192)throw new WebsiteError('invalid_oauth_token','OAuth authorization did not provide a valid token.');
    const accounts=await new HostingHttp('https://api.netlify.com',this.ports.fetch).request('/api/v1/accounts',accessToken);
    if(!Array.isArray(accounts)||!accounts.some(c=>c.id===state.accountId))throw new WebsiteError('account_changed','OAuth token does not authorize the selected account.');
    return this.save(a,{id:state.connectionId,family:'netlify',authorization:'oauth',accountId:state.accountId,secret:accessToken});
  }
  async connectPages(a:HostingConnectionActor,input:{accountId:string;token:string;id?:string}){await this.ports.authorize(a);if(!/^[a-f0-9]{32}$/i.test(input.accountId)||!input.token||input.token.length>8192)throw new WebsiteError('invalid_connection','Provide the Cloudflare account and restricted Pages token.');const response=await new HostingHttp('https://api.cloudflare.com',this.ports.fetch).request('/client/v4/accounts/'+input.accountId+'/pages/projects',input.token);if(response.success!==true)throw new WebsiteError('reconnect_required','Token cannot access Pages in this account.');return this.save(a,{id:input.id,family:'cloudflare-pages',authorization:'api_token',accountId:input.accountId,secret:input.token});}
  async connectSftp(a:HostingConnectionActor,input:{id?:string;accountId:string;username:string;privateKey:string;passphrase?:string}){await this.ports.authorize(a);if(!input.accountId||!input.username||!input.privateKey||input.privateKey.length>65536)throw new WebsiteError('invalid_connection','SFTP account, username and private key are required.');return this.save(a,{id:input.id,family:'sftp',authorization:'ssh_key',accountId:input.accountId,secret:JSON.stringify({username:input.username,privateKey:input.privateKey,passphrase:input.passphrase})});}
  async disconnect(a:HostingConnectionActor,id:string){await this.ports.authorize(a);const c=await this.ports.get(a.workspaceId,id);if(!c)throw new WebsiteError('connection_not_found','Connection was not found.');await this.ports.save({...c,state:'disconnected',credentialReference:undefined,revision:c.revision+1},c.revision);if(c.credentialReference)await this.ports.vault.revoke({cellId:this.ports.cellId,reference:c.credentialReference});}
}
