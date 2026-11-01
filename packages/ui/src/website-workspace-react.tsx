import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { parseContentBlocks, toStoredPostBlocks, type WebsiteDocument } from '@ubeeq/core';
import { BlockEditor, type BlockEditorMediaOption, type EditorWebsiteOptions } from './react.js';
import { createWebsiteWorkspace, type WebsiteWorkspaceClient, type WebsiteWorkspaceOptions, type WebsiteGalleryLinkEditorProps, type WebsiteGalleryWorksProps } from './website-workspace.js';

/** Website pages use the shared block editor, including its media insertion controls. */
export function WebsiteWorkspace({client,mediaOptions=[],options:workspaceOptions,settingsContent,renderGalleryLinkEditor,renderGalleryWorks}: {renderGalleryWorks?:(props:WebsiteGalleryWorksProps)=>ReactNode;renderGalleryLinkEditor?:(props:WebsiteGalleryLinkEditorProps)=>ReactNode;settingsContent?:ReactNode;client:WebsiteWorkspaceClient;mediaOptions?:BlockEditorMediaOption[];options?:WebsiteWorkspaceOptions}) {
  const root=useRef<HTMLDivElement>(null),pendingUploads=useRef(0),failedPreviews=useRef(new Set<string>()),activeClient=useRef(client);activeClient.current=client;
  const worksRenderer=useRef(renderGalleryWorks);worksRenderer.current=renderGalleryWorks;
  const hasWorksRenderer=!!renderGalleryWorks;
  const [workPanels,setWorkPanels]=useState<{host:HTMLElement;props:WebsiteGalleryWorksProps}[]>([]);
  const linkRenderer=useRef(renderGalleryLinkEditor);linkRenderer.current=renderGalleryLinkEditor;
  const hasLinkRenderer=!!renderGalleryLinkEditor;
  const [linkEditors,setLinkEditors]=useState<{host:HTMLElement;props:WebsiteGalleryLinkEditorProps}[]>([]);
  const [settingsHost,setSettingsHost]=useState<HTMLElement|null>(null);
  const [editor,setEditor]=useState<{host:HTMLElement;document:WebsiteDocument;change:(document:WebsiteDocument)=>void}|null>(null);
  const [images,setImages]=useState<BlockEditorMediaOption[]>(mediaOptions),[libraryError,setLibraryError]=useState('');
  const [options,setOptions]=useState<EditorWebsiteOptions>({pages:[],publications:[],creators:[]});
  useEffect(()=>{
    if(!root.current)return;
    setImages(mediaOptions);setOptions({pages:[],publications:[],creators:[]});failedPreviews.current.clear();let generation=0,disposed=false;
    const workspace=createWebsiteWorkspace(root.current,{...client,pendingUploads:()=>pendingUploads.current>0},(host,document,change)=>{
      const current=++generation;setLibraryError('');failedPreviews.current.clear();
      void Promise.all([client.get(),client.catalogue?.()??Promise.resolve([]),client.media?.()??Promise.resolve([]),client.creators?.()??Promise.resolve([])]).then(([site,catalogue,library,creators])=>{
        if(disposed||current!==generation)return;
        setImages(previous=>{const result=new Map(previous.map(image=>[image.mediaId,image]));for(const image of library){const old=result.get(image.id);result.set(image.id,{...old,mediaId:image.id,label:image.title,assetType:'image'});}return [...result.values()];});
        setOptions({galleries:site.namedGalleries?.map(gallery=>({id:gallery.id,title:(gallery.parentId?'↳ ':'')+gallery.title})),creators:[...creators],pages:site.pages.map(p=>({id:p.id,title:p.title})),publications:site.galleryPublicationIds.map(id=>({id,title:site.gallerySettings?.find(s=>s.publicationId===id)?.title??catalogue.find(p=>p.id===id)?.title??id}))});
      }).catch(error=>{if(!disposed&&current===generation)setLibraryError(error instanceof Error?error.message:'The image library could not be loaded.');});
      setEditor({host,document,change});
      return ()=>{generation++;setEditor(null);};
    },workspaceOptions,host=>{setSettingsHost(host);return ()=>setSettingsHost(null);},hasLinkRenderer?(host,props)=>{
      setLinkEditors(current=>[...current,{host,props}]);
      return ()=>setLinkEditors(current=>current.filter(editor=>editor.host!==host));
    }:undefined,hasWorksRenderer?(host,props)=>{
      setWorkPanels(current=>[...current,{host,props}]);
      return ()=>setWorkPanels(current=>current.filter(panel=>panel.host!==host));
    }:undefined);
    return ()=>{disposed=true;generation++;workspace.destroy();};
  },[client,workspaceOptions,hasLinkRenderer,hasWorksRenderer]);
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
  return <><div ref={root} />{workPanels.map(({host,props})=>createPortal(worksRenderer.current?.(props),host,props.galleryId))}{linkEditors.map(({host,props})=>createPortal(linkRenderer.current?.({...props,onChange:value=>{
    if(!root.current?.contains(host))return;
    props.onChange(value);setLinkEditors(current=>current.map(editor=>editor.host===host?{host,props:{...props,value}}:editor));
  }}),host,host.dataset.galleryLinkEditor))}{settingsHost&&settingsContent&&createPortal(settingsContent,settingsHost)}{editor&&createPortal(<>{libraryError&&<p role="alert">{libraryError}</p>}<BlockEditor key={editor.document.id} value={toStoredPostBlocks(editor.document.blocks)} allowMedia allowStructured uploadMedia={upload} mediaOptions={images} websiteOptions={options} label="" helpText="" onChange={value=>{
    if(!root.current?.contains(editor.host))return;
    const next={...editor.document,blocks:parseContentBlocks(value,{unbounded:true})};editor.change(next);setEditor({...editor,document:next});
  }}/></>,editor.host)}</>;
}
