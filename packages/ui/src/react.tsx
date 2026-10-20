import { useEffect, useMemo, useRef, useState } from 'react';
export { CropCanvas } from './crop-canvas.js';
export { PrivateMediaPlayer, type PrivateMediaPlayerProps } from './private-media-player.js';
export { BlockPreview, type BlockPreviewMedia, type BlockMediaRenderer } from './block-preview.js';
export { WebsiteWorkspace } from './website-workspace-react.js';
import type { StoredPostBlock as PostBlock } from '@ubeeq/core';
import {
  flattenWebsiteSections,
  splitParagraphBlock,
  createDescriptionBlock,
  createStructuredBlock,
  changeTextBlockType,
  movePostBlock,
  inlineHtmlToText,
  sanitizeInlineHtml,
  textToInlineHtml
} from './block-content.js';

export type BlockEditorMediaOption = {
  mediaId: string;
  label: string;
  thumbnailUrl?: string;
  assetType?: 'image' | 'video' | 'audio' | 'file';
  mimeType?: string;
};

export type BlockEditorProps = {
  value: PostBlock[];
  onChange: (blocks: PostBlock[]) => void;
  label?: string;
  helpText?: string;
  mediaOptions?: BlockEditorMediaOption[];
  allowMedia?: boolean;
  uploadMedia?: (file:File)=>Promise<BlockEditorMediaOption>;
  allowStructured?: boolean;
  websiteOptions?: { creators?: readonly {id:string;title:string}[]; pages: readonly { id: string; title: string }[]; publications: readonly { id: string; title: string }[] };
  readOnly?: boolean;
  sectionDepth?: number;
  stickyToolbarOffset?: number;
};

const textBlockTypes = new Set<PostBlock['type']>(['paragraph', 'heading', 'quote']);

function EditableBlockContent({
  block,
  setElement,
  onInput,
  readOnly = false
}: {
  block: PostBlock;
  setElement: (element: HTMLDivElement | null) => void;
  onInput: (html: string) => void;
  readOnly?: boolean;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const html = sanitizeInlineHtml(block.html !== undefined ? block.html : textToInlineHtml(block.quote || block.text || ''));

  useEffect(() => {
    const element = elementRef.current;
    if (!element || document.activeElement === element || element.innerHTML === html) return;
    element.innerHTML = html;
  }, [html]);

  return <div
    ref={(element) => {
      elementRef.current = element;
      setElement(element);
      if (element && document.activeElement !== element && element.innerHTML !== html) element.innerHTML = html;
    }}
    className={`portable-block-editor-content portable-block-editor-content-${block.type}`}
    contentEditable={!readOnly}
    suppressContentEditableWarning
    role="textbox"
    aria-readonly={readOnly}
    aria-multiline="true"
    data-placeholder={block.type === 'heading' ? 'Heading' : block.type === 'quote' ? 'Quote' : 'Write a paragraph…'}
    onInput={readOnly ? undefined : (event) => onInput(event.currentTarget.innerHTML)}
  />;
}

export function BlockEditor({
  value,
  onChange,
  label = 'Description',
  helpText = 'Build structured content that can be adapted for each connected platform.',
  mediaOptions = [],
  allowMedia = false,
  uploadMedia,
  allowStructured = false,
  websiteOptions,
  sectionDepth = 0,
  stickyToolbarOffset = 0,
  readOnly = false
}: BlockEditorProps) {
  const [emptyBlock] = useState(() => createDescriptionBlock());
  const toolbarRef=useRef<HTMLDivElement>(null);
  const [toolbarHeight,setToolbarHeight]=useState(0);
  useEffect(()=>{
    const toolbar=toolbarRef.current;if(!websiteOptions||!toolbar)return;
    const measure=()=>setToolbarHeight(toolbar.getBoundingClientRect().height);measure();
    if(typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(measure);observer.observe(toolbar);return()=>observer.disconnect();
  },[Boolean(websiteOptions),readOnly]);
  const normalized = useMemo(() => websiteOptions && sectionDepth === 0 ? flattenWebsiteSections(value) : value, [value, Boolean(websiteOptions), sectionDepth]);
  const blocks = normalized.length ? normalized : [emptyBlock];
  const [collapsedSections,setCollapsedSections]=useState<Set<string>>(()=>new Set());
  const [sectionProperties,setSectionProperties]=useState<Set<string>>(()=>new Set());
  const toggleSection=(id:string,properties=false)=>{const set=properties?setSectionProperties:setCollapsedSections;set(previous=>{const next=new Set(previous);if(next.has(id))next.delete(id);else next.add(id);return next;});};
  const [imageSettings,setImageSettings]=useState<Record<string,boolean>>({});
  const [uploadBusy,setUploadBusy]=useState(false),[uploadError,setUploadError]=useState('');
  const [uploadTarget,setUploadTarget]=useState(''),[imageErrors,setImageErrors]=useState<Record<string,string>>({});
  const [splitError,setSplitError]=useState(''),[splitStatus,setSplitStatus]=useState('');
  const uploadPending=useRef(false),mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const blocksRef=useRef(blocks);blocksRef.current=blocks;
  const editableRefs = useRef(new Map<string, HTMLDivElement>());
  const [activeBlockId, setActiveBlockId] = useState(blocks[0]?.blockId || '');
  useEffect(() => {
    if (!blocks.some(block => block.blockId === activeBlockId)) setActiveBlockId(blocks[0]?.blockId || '');
  }, [blocks, activeBlockId]);

  const activeBlockRef=useRef(activeBlockId);activeBlockRef.current=activeBlockId;
  const activeBlock = useMemo(() => blocks.find((block) => block.blockId === activeBlockId), [activeBlockId, blocks]);
  const activeBlockIndex = useMemo(() => blocks.findIndex((block) => block.blockId === activeBlockId), [activeBlockId, blocks]);
  const canFormat = Boolean(activeBlock && textBlockTypes.has(activeBlock.type));
  const canSplit=activeBlock?.type==='paragraph'&&/(?:<br\b|<\/(?:p|div)>|[\r\n])/i.test(activeBlock.html??activeBlock.text??'');
  const splitActiveParagraph=()=>{
    setSplitError('');setSplitStatus('');const current=blocksRef.current,index=current.findIndex(block=>block.blockId===activeBlockRef.current);if(index<0)return;
    try{const parts=splitParagraphBlock(current[index]);if(parts.length<2)return;editableRefs.current.get(current[index].blockId)?.blur();onChange([...current.slice(0,index),...parts,...current.slice(index+1)]);setActiveBlockId(parts[0].blockId);setSplitStatus(`Split into ${parts.length} paragraph blocks.`);window.setTimeout(()=>editableRefs.current.get(parts[0].blockId)?.focus(),0);}catch(error){setSplitError(error instanceof Error?error.message:'This paragraph could not be split.');}
  };

  const replaceBlock = (blockId: string, next: PostBlock) => {
    onChange(blocksRef.current.map((block) => block.blockId === blockId ? next : block));
  };

  const updateTextBlock = (block: PostBlock, htmlValue: string) => {
    const html = sanitizeInlineHtml(htmlValue);
    const text = inlineHtmlToText(html);
    replaceBlock(block.blockId, {
      ...block,
      text,
      html,
      ...(block.type === 'quote' ? { quote: text } : {})
    });
  };

  const addTextBlock = (type: 'paragraph' | 'heading' | 'quote' | 'divider' | 'section' | 'link' | 'credit') => {
    const block = type === 'section' || type === 'link' || type === 'credit' ? createStructuredBlock(type) : createDescriptionBlock(type);
    if(type === 'section')setSectionProperties(previous=>new Set([...previous,block.blockId]));
    const activeIndex = blocks.findIndex((item) => item.blockId === activeBlockId);
    const insertAt = activeIndex >= 0 ? activeIndex + 1 : blocks.length;
    const next = [...blocks];
    next.splice(insertAt, 0, block);
    onChange(next);
    setActiveBlockId(block.blockId);
    window.setTimeout(() => editableRefs.current.get(block.blockId)?.focus(), 0);
  };

  const addMediaBlock = (mediaId: string,uploaded?:BlockEditorMediaOption) => {
    const media = uploaded??mediaOptions.find((item) => item.mediaId === mediaId);
    if (!media) return;
    const block: PostBlock = {
      blockId: typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `block-${Date.now()}`,
      type: media.assetType || 'image',
      mediaId,
      ...(media.assetType === 'file' ? { label: media.label, mimeType: media.mimeType } : {}),
      caption: ''
    };
    const current=blocksRef.current;const activeIndex = current.findIndex((item) => item.blockId === activeBlockRef.current);
    const next = [...current];
    next.splice(activeIndex >= 0 ? activeIndex + 1 : current.length, 0, block);
    onChange(next);
    setActiveBlockId(block.blockId);
  };

  const addImageBlock=()=>{
    const block:PostBlock={blockId:globalThis.crypto?.randomUUID?.()??`image-${Date.now()}`,type:'image',caption:''};
    const current=blocksRef.current,index=current.findIndex(item=>item.blockId===activeBlockRef.current);const next=[...current];next.splice(index<0?current.length:index+1,0,block);onChange(next);setActiveBlockId(block.blockId);setImageSettings(previous=>({...previous,[block.blockId]:true}));
  };
  const patchImage=(id:string,patch:Partial<PostBlock>)=>{const current=blocksRef.current;if(current.some(block=>block.blockId===id))onChange(current.map(block=>block.blockId===id?{...block,...patch}:block));};
  const uploadImage=async(id:string,input:HTMLInputElement)=>{
    const file=input.files?.[0];if(!file||!uploadMedia||uploadPending.current)return;
    uploadPending.current=true;setUploadBusy(true);setUploadTarget(id);setImageErrors(previous=>({...previous,[id]:''}));
    try{const image=await uploadMedia(file);if(mounted.current)patchImage(id,{mediaId:image.mediaId});}
    catch(error){if(mounted.current)setImageErrors(previous=>({...previous,[id]:error instanceof Error?error.message:'The image could not be uploaded.'}));}
    finally{uploadPending.current=false;if(mounted.current){setUploadBusy(false);setUploadTarget('');input.value='';}}
  };
  const moveBlock = (index: number, direction: -1 | 1) => {
    if (!blocks[index]) return;
    onChange(movePostBlock(blocks, blocks[index].blockId, direction));
  };

  const removeBlock = (blockId: string) => {
    const next = blocks.filter((block) => block.blockId !== blockId);
    const fallback = next.length ? next : [createDescriptionBlock()];
    onChange(fallback);
    if (blockId === activeBlockId) setActiveBlockId(fallback[0].blockId);
  };

  const changeBlockType = (block: PostBlock, type: 'paragraph' | 'heading' | 'quote') => {
    replaceBlock(block.blockId, changeTextBlockType(block, type));
  };

  const updateActiveBlockType = (type: 'paragraph' | 'heading' | 'quote') => {
    if (!activeBlock || !textBlockTypes.has(activeBlock.type)) return;
    changeBlockType(activeBlock, type);
  };

  const runInlineCommand = (command: 'bold' | 'italic' | 'underline' | 'unlink') => {
    if (!canFormat) return;
    const element = editableRefs.current.get(activeBlockId);
    element?.focus();
    document.execCommand(command);
    if (activeBlock && element) updateTextBlock(activeBlock, element.innerHTML);
  };

  const addLink = () => {
    if (!canFormat) return;
    const url = window.prompt('Link URL');
    if (!url) return;
    const element = editableRefs.current.get(activeBlockId);
    element?.focus();
    document.execCommand('createLink', false, url);
    if (activeBlock && element) updateTextBlock(activeBlock, element.innerHTML);
  };

  return (
    <div className="portable-block-editor">
      <div className="portable-block-editor-heading">
        <div>
          <span className="portable-block-editor-label">{label}</span>
          <small>{helpText}</small>
        </div>
      </div>

      <div className="portable-block-editor-shell">
        {!readOnly && <div ref={toolbarRef} className="portable-block-editor-toolbar" style={websiteOptions?{top:`calc(var(--website-tools-height, 0px) + ${stickyToolbarOffset}px + .5rem)`,zIndex:10+sectionDepth}:undefined} aria-label="Active block tools">
          <div className="portable-block-editor-block-tools">
            {activeBlock && textBlockTypes.has(activeBlock.type) ? <select value={activeBlock.type} onChange={(event) => updateActiveBlockType(event.target.value as 'paragraph' | 'heading' | 'quote')} aria-label="Active block type">
              <option value="paragraph">Paragraph</option>
              <option value="heading">Heading</option>
              <option value="quote">Quote</option>
            </select> : <span className="portable-block-editor-active-type">{activeBlock?.type || 'Block'}</span>}
            {activeBlock?.type === 'heading' && <select value={activeBlock.level || 2} onChange={(event) => replaceBlock(activeBlock.blockId, { ...activeBlock, level: Number(event.target.value) })} aria-label="Heading level">
              <option value="2">H2</option>
              <option value="3">H3</option>
            </select>}
            <button type="button" disabled={activeBlockIndex <= 0} onClick={() => moveBlock(activeBlockIndex, -1)} aria-label="Move block up">↑</button>
            <button type="button" disabled={activeBlockIndex < 0 || activeBlockIndex === blocks.length - 1} onClick={() => moveBlock(activeBlockIndex, 1)} aria-label="Move block down">↓</button>
          </div>
          <div className="portable-block-editor-formatting" aria-label="Text formatting">
            <button type="button" disabled={!canFormat} onMouseDown={(event) => event.preventDefault()} onClick={() => runInlineCommand('bold')} aria-label="Bold"><strong>B</strong></button>
            <button type="button" disabled={!canFormat} onMouseDown={(event) => event.preventDefault()} onClick={() => runInlineCommand('italic')} aria-label="Italic"><em>I</em></button>
            <button type="button" disabled={!canFormat} onMouseDown={(event) => event.preventDefault()} onClick={() => runInlineCommand('underline')} aria-label="Underline"><u>U</u></button>
            <button type="button" disabled={!canFormat} onMouseDown={(event) => event.preventDefault()} onClick={addLink}>Link</button>
            <button type="button" disabled={!canFormat} onMouseDown={(event) => event.preventDefault()} onClick={() => runInlineCommand('unlink')}>Unlink</button>
            <button type="button" disabled={!canSplit} onMouseDown={event=>event.preventDefault()} onClick={splitActiveParagraph} title="Create a separate paragraph block for each non-empty line, preserving text formatting and links">Split into paragraphs</button>
          </div>
          <button type="button" className="portable-block-editor-remove" disabled={!activeBlock} onClick={() => activeBlock && removeBlock(activeBlock.blockId)}>Remove block</button>
        </div>}

        {splitError&&<p role="alert">{splitError}</p>}{splitStatus&&<p role="status">{splitStatus}</p>}
        <div className="portable-block-editor-canvas" onClick={() => {
          if (!activeBlockId && blocks[0]) setActiveBlockId(blocks[0].blockId);
        }}>
        {blocks.map((block) => {
          const isTextBlock = textBlockTypes.has(block.type);
          const media = block.mediaId ? mediaOptions.find((item) => item.mediaId === block.mediaId) : undefined;
          return (
            <article
              key={block.blockId}
              className={`portable-block-editor-block portable-block-editor-block-${block.type}${block.blockId === activeBlockId ? ' is-active' : ''}`}
              onClick={() => setActiveBlockId(block.blockId)}
              onFocus={() => setActiveBlockId(block.blockId)}
              tabIndex={isTextBlock ? -1 : 0}
            >
              {isTextBlock && <EditableBlockContent
                block={block}
                setElement={(element) => {
                  if (element) editableRefs.current.set(block.blockId, element);
                  else editableRefs.current.delete(block.blockId);
                }}
                onInput={(html) => updateTextBlock(block, html)}
                readOnly={readOnly}
              />}
              {block.type === 'divider' && <hr />}
              {block.type === 'section' && <div>
                {websiteOptions && <div className="portable-section-heading">
                  <button type="button" className="portable-section-collapse" aria-expanded={!collapsedSections.has(block.blockId)} onClick={()=>toggleSection(block.blockId)}><span aria-hidden="true">{collapsedSections.has(block.blockId)?'▸':'▾'}</span> {block.title || 'Untitled section'}</button>
                  {!readOnly && <button type="button" onClick={()=>removeBlock(block.blockId)} aria-label={`Remove section ${block.title || 'Untitled section'}`}>Remove section</button>}
                </div>}
                <div hidden={Boolean(websiteOptions)&&collapsedSections.has(block.blockId)}>
                {websiteOptions ? <div className="portable-section-properties">
                  <button type="button" className="portable-section-more" aria-expanded={sectionProperties.has(block.blockId)} onClick={()=>toggleSection(block.blockId,true)}>More Actions <span aria-hidden="true">{sectionProperties.has(block.blockId)?'▴':'▾'}</span></button>
                  <div hidden={!sectionProperties.has(block.blockId)}>
                {websiteOptions && <label>Section layout<select disabled={readOnly} value={String(block.payload?.presentation || 'standard')} onChange={event=>replaceBlock(block.blockId,{...block,payload:{...block.payload,presentation:event.target.value}})}>{['standard','intro','callout','pricing','plan','faq','faq_item','screening','excerpt','bibliography','release','episode','episodes','creators'].map(value=><option key={value} value={value}>{({standard:'Standard',intro:'Hero introduction',callout:'Membership / offer callout',pricing:'Plan comparison',plan:'Plan card',faq:'Questions',faq_item:'Expandable answer',screening:'Featured film',excerpt:'Literary excerpt',bibliography:'Book / publication listing',release:'Audio release / track list',episode:'Featured episode / show notes',episodes:'Episode listing',creators:'Contributing creators'})[value]}</option>)}</select></label>}

                <label>Section title<input value={block.title || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, title: event.target.value })} /></label>
                  </div>
                </div> : <label>Section title<input value={block.title || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, title: event.target.value })} /></label>}
                <div onClick={event=>{setActiveBlockId(block.blockId);event.stopPropagation();}} onFocus={event=>{setActiveBlockId(block.blockId);event.stopPropagation();}}>
                <BlockEditor value={block.blocks || []} readOnly={readOnly} mediaOptions={mediaOptions} allowMedia={allowMedia} uploadMedia={uploadMedia} allowStructured={allowStructured} websiteOptions={websiteOptions} sectionDepth={sectionDepth+1} stickyToolbarOffset={stickyToolbarOffset+toolbarHeight}
                  label="Section content" helpText="Add and arrange content in this section." onChange={next => replaceBlock(block.blockId, { ...block, blocks: next })} />
                </div></div>
              </div>}
              {block.type === 'link' && <div>
                {websiteOptions && <><label>Link destination<select disabled={readOnly} value={String(block.payload?.action || 'custom')} onChange={event=>replaceBlock(block.blockId,{...block,payload:{...block.payload,action:event.target.value}})}>{[['custom','Custom URL'],['membership','Platform membership / checkout'],['account','Platform membership account'],['mailing','Platform mailing-list / offer'],['booking','Platform session booking'],['clients','Platform private client galleries'],['trailer','Featured trailer / playback'],['podcast_feed','Public podcast feed'],['sponsorship','Sponsorship information'],['inquiry','Commission / service inquiry'],['tickets','Tickets / attendance'],['course','Course / workshop enrollment'],['store','Store / checkout destination'],['audio','Featured audio / listening'],['release','Release purchase'],['merch','Merchandise store']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>Link style<select disabled={readOnly} value={String(block.payload?.appearance || 'text')} onChange={event=>replaceBlock(block.blockId,{...block,payload:{...block.payload,appearance:event.target.value}})}>{['text','primary','secondary'].map(value=><option key={value} value={value}>{value}</option>)}</select></label></>}

                <label>Link label<input value={block.label || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, label: event.target.value })} /></label>
                {websiteOptions && ['membership','account','mailing','booking','clients','trailer','audio','release','merch','podcast_feed','sponsorship','inquiry','tickets','course','store'].includes(String(block.payload?.action)) ? <p>This link follows the platform URL in Appearance and stays hidden until that URL is configured.</p> : <label>Link URL<input value={block.url || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, url: event.target.value })} /></label>}
              </div>}
              {block.type === 'credit' && <div>
                <label>Credit author<input value={block.author || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, author: event.target.value })} /></label>
                <label>Credit text<textarea value={block.text || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, text: event.target.value })} /></label>
                <label>Credit URL<input value={block.url || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, url: event.target.value })} /></label>
              </div>}
              {websiteOptions && ['gallery_preview','premium_promotion','selected_portfolio','gallery_list','update_list','page_link'].includes(block.type) && <fieldset disabled={readOnly}>
                <legend>{block.type.replaceAll('_',' ')}</legend>
                {block.type === 'premium_promotion' && <p>Only approved public previews are exported. Access remains at the external destination.</p>}
                {block.type === 'page_link' ? <label>Page<select value={String(block.payload?.pageId ?? '')} onChange={event=>replaceBlock(block.blockId,{...block,payload:{...block.payload,pageId:event.target.value}})}>
                  <option value="">Choose a page</option>{websiteOptions.pages.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}
                </select></label> : block.type !== 'update_list' && <label>Publications<select multiple={['selected_portfolio','gallery_list'].includes(block.type)} value={['selected_portfolio','gallery_list'].includes(block.type)?(block.payload?.publicationIds as string[] ?? []):String((block.payload?.publicationIds as string[] ?? [])[0] ?? '')} onChange={event=>replaceBlock(block.blockId,{...block,payload:{...block.payload,publicationIds:Array.from(event.target.selectedOptions).map(o=>o.value).filter(Boolean)}})}>
                  {!['selected_portfolio','gallery_list'].includes(block.type)&&<option value="">Choose the intended publication</option>}{websiteOptions.publications.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}
                </select></label>}
                {['gallery_list','update_list'].includes(block.type)&&<>
                  <label>Page size<input type="number" min={1} max={100} value={Number(block.payload?.pageSize ?? 12)} onChange={event=>replaceBlock(block.blockId,{...block,payload:{...block.payload,pageSize:Number(event.target.value)}})}/></label>
                  <label>Empty message<input value={String(block.payload?.emptyMessage ?? 'No entries yet.')} onChange={event=>replaceBlock(block.blockId,{...block,payload:{...block.payload,emptyMessage:event.target.value}})}/></label>
                </>}
                {block.type==='gallery_list'&&websiteOptions.creators&&<label>Creator identities · leave unselected for all<select multiple value={(block.payload?.creatorIdentityIds as string[])??[]} onChange={event=>replaceBlock(block.blockId,{...block,payload:{...block.payload,creatorIdentityIds:Array.from(event.target.selectedOptions).map(option=>option.value)}})}>{[...websiteOptions.creators,...((block.payload?.creatorIdentityIds as string[])??[]).filter(id=>!websiteOptions.creators!.some(creator=>creator.id===id)).map(id=>({id,title:'Disconnected identity · '+id}))].map(creator=><option key={creator.id} value={creator.id}>{creator.title}</option>)}</select></label>}
                {block.type==='gallery_list'&&<label>Tags (comma separated)<input value={((block.payload?.tags as string[])??[]).join(', ')} onChange={event=>replaceBlock(block.blockId,{...block,payload:{...block.payload,tags:event.target.value.split(',').map(t=>t.trim()).filter(Boolean)}})}/></label>}
              </fieldset>}
              {!isTextBlock && !['section', 'divider', 'image', 'video', 'audio', 'file', 'link', 'credit', ...(websiteOptions?['gallery_preview','premium_promotion','selected_portfolio','gallery_list','update_list','page_link']:[])].includes(block.type) && <p>Preserved {block.type} block — static export requires an explicit renderer or accepted fallback.</p>}
              {block.type === 'file' && <div className="portable-block-editor-file">
                <p>Attached file: {media?.label || block.label || block.fileId || block.mediaId || 'Unavailable reference'}</p>
                <label>File label<input value={block.label || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, label: event.target.value })} /></label>
                <label>Caption<input value={block.caption || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, caption: event.target.value })} /></label>
                <small>File contents are not displayed here. Downloads require the application's authorized attachment route.</small>
              </div>}
              {block.type === 'image' && websiteOptions ? <div className="portable-block-editor-image">
                <div className="portable-image-stage">
                  <figure className={`portable-image-preview align-${String(block.payload?.alignment??'left')}`} style={{'--image-desktop-width':`${Number(block.payload?.desktopWidth??(block.payload?.textFlow==='wrap'?45:100))}%`,'--image-mobile-width':`${Number(block.payload?.mobileWidth??100)}%`} as React.CSSProperties}>
                    {media?.thumbnailUrl?<img src={media.thumbnailUrl} alt={String(block.payload?.alt??media.label)}/>:<div className="portable-image-placeholder">{media?.label||(block.mediaId?'Selected image':'Choose an image')}</div>}
                    {block.caption&&<figcaption>{block.caption}</figcaption>}
                    <button type="button" className="portable-image-settings-toggle" aria-label="Image settings" aria-expanded={imageSettings[block.blockId]??!block.mediaId} aria-controls={`image-settings-${block.blockId}`} onClick={()=>setImageSettings(previous=>({...previous,[block.blockId]:!(previous[block.blockId]??!block.mediaId)}))}><span aria-hidden="true">•••</span></button>
                  </figure>
                </div>
                <div id={`image-settings-${block.blockId}`} className="portable-image-controls" hidden={!(imageSettings[block.blockId]??!block.mediaId)}>
                  <fieldset disabled={readOnly} className="portable-image-source"><legend>Image</legend>
                    <label>Choose existing image<select aria-label="Choose existing image" value={block.mediaId??''} onChange={event=>patchImage(block.blockId,{mediaId:event.target.value||undefined})}>
                      <option value="">Choose from Works or uploads…</option>
                      {block.mediaId&&!mediaOptions.some(item=>item.mediaId===block.mediaId)&&<option value={block.mediaId}>Current image</option>}
                      {mediaOptions.filter(item=>!item.assetType||item.assetType==='image').map(item=><option key={item.mediaId} value={item.mediaId}>{item.label}</option>)}
                    </select></label>
                    {uploadMedia&&<label className="portable-block-editor-upload">{uploadTarget===block.blockId?'Uploading image…':'Upload image'}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" disabled={readOnly||uploadBusy} onChange={event=>void uploadImage(block.blockId,event.currentTarget)}/></label>}
                    {imageErrors[block.blockId]&&<p role="alert">{imageErrors[block.blockId]}</p>}
                  </fieldset>
                <fieldset disabled={readOnly} className="portable-image-settings">
                  <label>Caption<input value={block.caption??''} onChange={event=>patchImage(block.blockId,{caption:event.target.value})}/></label>
                  <label>Image description (alt text)<input maxLength={2000} value={String(block.payload?.alt??'')} placeholder={media?.label??'Describe the image'} onChange={event=>patchImage(block.blockId,{payload:{...block.payload,alt:event.target.value||undefined}})}/></label>
                  <label>Image alignment<select aria-label="Image alignment" value={String(block.payload?.alignment??'left')} onChange={event=>patchImage(block.blockId,{payload:{...block.payload,alignment:event.target.value,...(['center','full'].includes(event.target.value)?{textFlow:'separate'}:{}),...(event.target.value==='full'?{desktopWidth:100}:{})}})}>{[['left','Left'],['center','Center'],['right','Right'],['full','Full width']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
                  <label>Text flow<select aria-label="Text flow" value={String(block.payload?.textFlow??'separate')} onChange={event=>patchImage(block.blockId,{payload:{...block.payload,textFlow:event.target.value}})}><option value="separate">Text below image</option><option value="wrap" disabled={!['left','right'].includes(String(block.payload?.alignment??'left'))}>Wrap following text around image</option></select></label>
                  {(['desktop','mobile'] as const).map(device=><label key={device}>{device==='desktop'?'Desktop width (%)':'Mobile width (%)'}<input type="number" min={1} max={100} step={1} value={Number(block.payload?.[device+'Width']??(device==='desktop'&&block.payload?.textFlow==='wrap'?45:100))} onChange={event=>{const width=event.currentTarget.valueAsNumber;if(Number.isInteger(width)&&width>=1&&width<=100)patchImage(block.blockId,{payload:{...block.payload,[device+'Width']:width,...(device==='desktop'&&width<100&&block.payload?.alignment==='full'?{alignment:'center'}:{})}});}}/></label>)}
                  <p>Width is a percentage of the page’s content area. Mobile applies at 640px and below. Image proportions are preserved.</p>
                  <p>Wrap is available for left- and right-aligned images and applies to the following text blocks. Images stack above text on small screens.</p>
                </fieldset>
                </div>
              </div> : (block.type === 'image' || block.type === 'video' || block.type === 'audio') && <div className="portable-block-editor-media">
                {media?.thumbnailUrl && block.type === 'image' ? <img src={media.thumbnailUrl} alt="" /> : <div className="portable-block-editor-media-placeholder">{media?.label || block.mediaId || 'Media'}</div>}
                <label>
                  <span>Caption</span>
                  <input value={block.caption || ''} readOnly={readOnly} onChange={(event) => replaceBlock(block.blockId, { ...block, caption: event.target.value })} />
                </label>
              </div>}
            </article>
          );
        })}
        </div>

        {!readOnly && <div className="portable-block-editor-add" aria-label="Add content block">
          <span className="portable-block-editor-inserter-icon" aria-hidden="true">+</span>
          <span>Add block</span>
          <button type="button" onClick={() => addTextBlock('paragraph')}>Paragraph</button>
          {websiteOptions&&allowMedia&&<button type="button" onClick={addImageBlock}>Image</button>}
          <button type="button" onClick={() => addTextBlock('heading')}>Heading</button>
          <button type="button" onClick={() => addTextBlock('quote')}>Quote</button>
          <button type="button" onClick={() => addTextBlock('divider')}>Divider</button>
          {allowStructured && <>
            {(!websiteOptions || sectionDepth === 0) && <button type="button" onClick={() => addTextBlock('section')}>Section</button>}
            <button type="button" onClick={() => addTextBlock('link')}>Link block</button>
            <button type="button" onClick={() => addTextBlock('credit')}>Credit</button>
          </>}
          {websiteOptions && <select defaultValue="" aria-label="Add website block" onChange={event=>{
            const type=event.target.value as PostBlock['type'];if(!type)return;
            const next:PostBlock={blockId:globalThis.crypto.randomUUID(),type,payload:{...(type==='page_link'?{pageId:''}:type==='update_list'?{pageSize:12}:{publicationIds:[],...(type==='gallery_list'?{pageSize:12}: {})})}};
            onChange([...blocks,next]);setActiveBlockId(next.blockId);event.target.value='';
          }}><option value="">Add website block…</option>{['gallery_preview','premium_promotion','selected_portfolio','gallery_list','update_list','page_link'].map(type=><option key={type} value={type}>{type.replaceAll('_',' ')}</option>)}</select>}
          {!websiteOptions&&allowMedia&&uploadMedia&&<label className="portable-block-editor-upload">{uploadBusy?'Uploading image…':'Upload image'}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" disabled={uploadBusy} onChange={async event=>{
            const input=event.currentTarget,file=input.files?.[0];if(!file||uploadPending.current)return;uploadPending.current=true;setUploadBusy(true);setUploadError('');
            try{const image=await uploadMedia(file);if(mounted.current)addMediaBlock(image.mediaId,image);}catch(error){if(mounted.current)setUploadError(error instanceof Error?error.message:'The image could not be uploaded.');}finally{uploadPending.current=false;if(mounted.current){setUploadBusy(false);input.value='';}}
          }}/></label>}
          {uploadError&&<p role="alert">{uploadError}</p>}
          {!websiteOptions && allowMedia && mediaOptions.length > 0 && <select defaultValue="" onChange={(event) => {
            addMediaBlock(event.target.value);
            event.target.value = '';
          }} aria-label={websiteOptions?"Add image from existing Works or uploads":"Add media block"}>
            <option value="">{websiteOptions?"Choose an existing Work image or upload…":"Add attached media or file…"}</option>
            {mediaOptions.map((media) => <option key={media.mediaId} value={media.mediaId}>{media.label}</option>)}
          </select>}
        </div>}
      </div>
    </div>
  );
}
