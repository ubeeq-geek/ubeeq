import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WebsiteWorkspace, type BlockEditorMediaOption } from '@ubeeq/ui/react';
import { WebsiteClient } from '@ubeeq/ui';

// The documented Netlify implicit OAuth response is immediately removed from browser history.
const hostingOAuthReturn=(()=>{const params=new URLSearchParams(location.hash.slice(1));if(!params.has('access_token'))return undefined;const result={state:params.get('state')??'',accessToken:params.get('access_token')??''};history.replaceState(null,'',location.pathname+location.search);return result;})();
function Websites() {
  const [token]=useState(()=>localStorage.getItem('ubeeq.reference.token')??'');
  const [sites,setSites]=useState<{id:string;title:string}[]>([]),[id,setId]=useState(''),[title,setTitle]=useState('My website'),[status,setStatus]=useState(''),[media,setMedia]=useState<BlockEditorMediaOption[]>([]);
  const [publications,setPublications]=useState<{id:string;title:string}[]>([]);
  const client=useMemo(()=>id?new WebsiteClient(id,()=>token):undefined,[id,token]);
  const api=async(path:string,method='GET',body?:unknown)=>{
    const response=await fetch('/api/v1/'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',redirect:'error'});
    const result=await response.json();if(!response.ok)throw new Error(result.error?.message??'Website operation failed.');return result;
  };
  useEffect(()=>{if(token&&hostingOAuthReturn){const payload={...hostingOAuthReturn};hostingOAuthReturn.accessToken='';void api('websites/hosting-connections/netlify-callback','POST',payload).then(()=>setStatus('Netlify connected. Select a provider site in Publishing.')).catch(e=>setStatus(e.message));}},[token]);
  useEffect(()=>{let active=true;if(token)void api('websites').then(r=>{if(active){setSites(r.websites);setId(r.websites[0]?.id??'');}}).catch(e=>setStatus(e.message));return()=>{active=false;};},[token]);
  useEffect(()=>{if(token)void api('websites/catalogue').then(r=>{setPublications(r.publications);setMedia(r.publications.flatMap((p:{assets:{id:string;label:string}[]})=>p.assets.map(a=>({mediaId:a.id,label:a.label,assetType:'image' as const}))));}).catch(e=>setStatus(e.message));},[token]);
  const create=async()=>{
    try{
      const {creator}=await api('creators/me'),websiteId=crypto.randomUUID(),documentId=crypto.randomUUID(),pageId=crypto.randomUUID();
      const next=new WebsiteClient(websiteId,()=>token);
      await next.saveDocument({id:documentId,workspaceId:creator.id,revision:1,blocks:[]},0);
      await next.save({id:websiteId,workspaceId:creator.id,creatorIdentityId:creator.id,revision:1,title,locale:'en',homePageId:pageId,theme:{id:'neutral',version:'1',settings:{}},galleryDefault:{destination:{mode:'local'},missing:'error'},mediaMode:'bundled',basePath:'/',pages:[{id:pageId,websiteId,workspaceId:creator.id,documentId,revision:1,kind:'home',title:'Home',slug:'',order:0,state:'ready',navigation:true}],galleryPublicationIds:[],redirects:[]},0);
      setSites([...sites,{id:websiteId,title}]);setId(websiteId);setStatus('Website created. Open Home to begin writing.');
    }catch(e){setStatus(e instanceof Error?e.message:'Website creation failed.');}
  };
  if(!token)return <p><a href="/workspace">Sign in and create a creator profile</a> to manage websites.</p>;
  return <><header><h1>Websites</h1><p>Create a portable website from your content.</p></header><p role="status">{status}</p>
    <section aria-label="Choose a website"><label>Website<select value={id} onChange={e=>setId(e.target.value)}><option value="">Choose a website</option>{sites.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></label><label>New website title<input value={title} onChange={e=>setTitle(e.target.value)}/></label><button onClick={()=>void create()}>Create website</button></section>
    {publications.length>0&&<details><summary>Available public publications</summary><p>Choose these public presentations in Gallery destinations before inserting gallery blocks.</p><ul>{publications.map(p=><li key={p.id}>{p.title}</li>)}</ul></details>}
    {client&&<WebsiteWorkspace key={id} client={client} mediaOptions={media}/>}</>;
}
createRoot(document.getElementById('websites')!).render(<Websites/>);
