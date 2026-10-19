import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { parseContentBlocks, toStoredPostBlocks, type WebsiteDocument } from '@ubeeq/core';
import { BlockEditor, type BlockEditorMediaOption } from './react.js';
import { createWebsiteWorkspace, type WebsiteWorkspaceClient, type WebsiteWorkspaceOptions } from './website-workspace.js';

/** Website pages use the shared block editor, including its media insertion controls. */
export function WebsiteWorkspace({client,mediaOptions=[],options:workspaceOptions}: {client:WebsiteWorkspaceClient;mediaOptions?:BlockEditorMediaOption[];options?:WebsiteWorkspaceOptions}) {
  const root=useRef<HTMLDivElement>(null),pendingUploads=useRef(0),failedPreviews=useRef(new Set<string>()),activeClient=useRef(client);activeClient.current=client;
  const [editor,setEditor]=useState<{host:HTMLElement;document:WebsiteDocument;change:(document:WebsiteDocument)=>void}|null>(null);
  const [images,setImages]=useState<BlockEditorMediaOption[]>(mediaOptions),[libraryError,setLibraryError]=useState('');
  const [options,setOptions]=useState<{pages:{id:string;title:string}[];publications:{id:string;title:string}[];creators:{id:string;title:string}[]}>({pages:[],publications:[],creators:[]});
  useEffect(()=>{
    if(!root.current)return;
    setImages(mediaOptions);setOptions({pages:[],publications:[],creators:[]});failedPreviews.current.clear();let generation=0,disposed=false;
    const workspace=createWebsiteWorkspace(root.current,{...client,pendingUploads:()=>pendingUploads.current>0},(host,document,change)=>{
      const current=++generation;setLibraryError('');failedPreviews.current.clear();
      void Promise.all([client.get(),client.catalogue?.()??Promise.resolve([]),client.media?.()??Promise.resolve([]),client.creators?.()??Promise.resolve([])]).then(([site,catalogue,library,creators])=>{
        if(disposed||current!==generation)return;
        setImages(previous=>{const result=new Map(previous.map(image=>[image.mediaId,image]));for(const image of library){const old=result.get(image.id);result.set(image.id,{...old,mediaId:image.id,label:image.title,assetType:'image'});}return [...result.values()];});
        setOptions({creators:[...creators],pages:site.pages.map(p=>({id:p.id,title:p.title})),publications:site.galleryPublicationIds.map(id=>({id,title:site.gallerySettings?.find(s=>s.publicationId===id)?.title??catalogue.find(p=>p.id===id)?.title??id}))});
      }).catch(error=>{if(!disposed&&current===generation)setLibraryError(error instanceof Error?error.message:'The image library could not be loaded.');});
      setEditor({host,document,change});
      return ()=>{generation++;setEditor(null);};
    },workspaceOptions);
    return ()=>{disposed=true;generation++;workspace.destroy();};
  },[client,workspaceOptions]);
  useEffect(()=>{
    if(!editor||!client.mediaPreview)return;
    let active=true;const ids=new Set<string>(),blocks=[...editor.document.blocks];
    while(blocks.length){const block=blocks.pop()!;if(block.type==='image'&&(block.assetId||block.fileId))ids.add(block.assetId??block.fileId!);if(block.children)blocks.push(...block.children);}
    for(const id of ids)if(!images.find(image=>image.mediaId===id)?.thumbnailUrl&&!failedPreviews.current.has(id))void client.mediaPreview(id).then(url=>{if(active)setImages(previous=>{const known=previous.find(image=>image.mediaId===id);return [...previous.filter(image=>image.mediaId!==id),{...known,mediaId:id,label:known?.label??'Page image',assetType:'image',thumbnailUrl:url}];});}).catch(()=>{if(active){failedPreviews.current.add(id);setLibraryError('A page image could not be previewed. Check its availability or choose another image.');}});
    return()=>{active=false;};
  },[client,editor?.document,images]);
  const upload=client.uploadMedia?async(file:File)=>{
    if(file.size>10*1024*1024)throw new Error('Choose an image up to 10 MiB.');
    pendingUploads.current++;
    try{const image=await client.uploadMedia!(file),option:BlockEditorMediaOption={mediaId:image.id,label:image.title,assetType:'image'};
      if(client.mediaPreview)option.thumbnailUrl=await client.mediaPreview(image.id);
      if(activeClient.current===client)setImages(previous=>[...previous.filter(existing=>existing.mediaId!==option.mediaId),option]);return option;
    }finally{pendingUploads.current--;}
  }:undefined;
  return <><div ref={root} />{editor&&createPortal(<>{libraryError&&<p role="alert">{libraryError}</p>}<BlockEditor value={toStoredPostBlocks(editor.document.blocks)} allowMedia allowStructured uploadMedia={upload} mediaOptions={images} websiteOptions={options} label="Page content" helpText="Add and arrange content blocks. Insert an existing Work image or upload an image directly here." onChange={value=>{
    if(!root.current?.contains(editor.host))return;
    const next={...editor.document,blocks:parseContentBlocks(value,{unbounded:true})};editor.change(next);setEditor({...editor,document:next});
  }}/></>,editor.host)}</>;
}
