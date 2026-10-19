import type { Website, WebsiteDocument } from '@ubeeq/core';
import type { WebsiteWorkspaceClient } from './website-workspace.js';

/** In-memory bearer provider, same-origin API transport; no credentials enter preview HTML. */
export class WebsiteClient implements WebsiteWorkspaceClient {
  constructor(private readonly websiteId: string, private readonly token: () => string | undefined, private readonly basePath = '/api/v1/websites') {
    if(!websiteId || !basePath.startsWith('/') || basePath.startsWith('//') || /[?#\\]/.test(basePath)) throw new Error('A website ID and same-origin API path are required.');
  }
  private async request(path:string,method='GET',body?:unknown) {
    const credential=this.token();
    if(!credential)throw new Error('Sign in to manage a website.');
    const response=await fetch(this.basePath+path,{method,headers:{authorization:`Bearer ${credential}`,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',redirect:'error'});
    if(!response.ok){let message='Website operation failed.';try{message=(await response.json()).error?.message??message;}catch{}throw new Error(message);}
    return response;
  }
  async get() {return (await(await this.request('/'+encodeURIComponent(this.websiteId))).json()).website as Website;}
  async catalogue() {return (await(await this.request('/catalogue')).json()).publications as {id:string;title:string}[];}
  async save(website:Website,expectedRevision:number) {return (await(await this.request('/'+encodeURIComponent(this.websiteId),'PUT',{website,expectedRevision})).json()).website as Website;}
  async document(id:string) {return (await this.request('/documents/'+encodeURIComponent(id))).json();}
  async saveDocument(document:WebsiteDocument,expectedRevision:number) {return (await(await this.request('/documents/'+encodeURIComponent(document.id),'PUT',{document,expectedRevision})).json()).document as WebsiteDocument;}
  async requestBuild(expectedRevision:number,idempotencyKey:string) {return (await(await this.request('/'+encodeURIComponent(this.websiteId)+'/builds','POST',{expectedRevision,idempotencyKey})).json()).build;}
  async build(id:string) {return (await(await this.request('/builds/'+encodeURIComponent(id))).json()).build;}
  async builds() {return (await(await this.request('/'+encodeURIComponent(this.websiteId)+'/builds')).json()).builds;}
  async previewPages(id:string) {return (await(await this.request('/builds/'+encodeURIComponent(id)+'/pages')).json()).pages;}
  async export(id:string) {return (await this.request('/builds/'+encodeURIComponent(id)+'/export')).blob();}
  async preview(id:string,file='index.html') {return (await this.request('/builds/'+encodeURIComponent(id)+'/preview?inline=1&file='+encodeURIComponent(file))).text();}
}
