import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { parseContentBlocks, toStoredPostBlocks, type WebsiteDocument } from '@ubeeq/core';
import { BlockEditor, type BlockEditorMediaOption } from './react.js';
import { createWebsiteWorkspace, type WebsiteWorkspaceClient, type WebsiteWorkspaceOptions } from './website-workspace.js';

/** Website management uses the same long-form BlockEditor as every other destination. */
export function WebsiteWorkspace({client,mediaOptions=[],options:workspaceOptions}: {client:WebsiteWorkspaceClient;mediaOptions?:BlockEditorMediaOption[];options?:WebsiteWorkspaceOptions}) {
  const root=useRef<HTMLDivElement>(null);
  const [editor,setEditor]=useState<{host:HTMLElement;document:WebsiteDocument;change:(document:WebsiteDocument)=>void}|null>(null);
  const [images,setImages]=useState<BlockEditorMediaOption[]>(mediaOptions);
  const [options,setOptions]=useState<{pages:{id:string;title:string}[];publications:{id:string;title:string}[];creators:{id:string;title:string}[]}>({pages:[],publications:[],creators:[]});
  useEffect(()=>{
    if(!root.current)return;
    const workspace=createWebsiteWorkspace(root.current,client,(host,document,change)=>{
      void Promise.all([client.get(),client.catalogue?.()??Promise.resolve([]),client.media?.()??Promise.resolve([]),client.creators?.()??Promise.resolve([])]).then(([site,catalogue,library,creators])=>{setImages([...mediaOptions,...library.filter(image=>!mediaOptions.some(m=>m.mediaId===image.id)).map(image=>({mediaId:image.id,label:image.title,assetType:'image' as const}))]);setOptions({creators:[...creators],pages:site.pages.map(p=>({id:p.id,title:p.title})),publications:site.galleryPublicationIds.map(id=>({id,title:site.gallerySettings?.find(s=>s.publicationId===id)?.title??catalogue.find(p=>p.id===id)?.title??id}))});}).catch(()=>{});
      setEditor({host,document,change});
      return ()=>setEditor(null);
    },workspaceOptions);
    return ()=>workspace.destroy();
  },[client,workspaceOptions]);
  return <><div ref={root} />{editor&&createPortal(<BlockEditor value={toStoredPostBlocks(editor.document.blocks)} allowMedia allowStructured mediaOptions={images} websiteOptions={options} label="Page content" onChange={value=>{
    const next={...editor.document,blocks:parseContentBlocks(value,{unbounded:true})};editor.change(next);setEditor({...editor,document:next});
  }}/>,editor.host)}</>;
}
