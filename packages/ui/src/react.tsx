import { useEffect, useMemo, useRef, useState } from 'react';
export { CropCanvas } from './crop-canvas.js';
export { PrivateMediaPlayer, type PrivateMediaPlayerProps } from './private-media-player.js';
export { BlockPreview, type BlockPreviewMedia, type BlockMediaRenderer } from './block-preview.js';
import type { StoredPostBlock as PostBlock } from '@ubeeq/core';
import {
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
  allowStructured?: boolean;
  readOnly?: boolean;
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
  allowStructured = false,
  readOnly = false
}: BlockEditorProps) {
  const [emptyBlock] = useState(() => createDescriptionBlock());
  const blocks = value.length ? value : [emptyBlock];
  const editableRefs = useRef(new Map<string, HTMLDivElement>());
  const [activeBlockId, setActiveBlockId] = useState(blocks[0]?.blockId || '');
  useEffect(() => {
    if (!blocks.some(block => block.blockId === activeBlockId)) setActiveBlockId(blocks[0]?.blockId || '');
  }, [blocks, activeBlockId]);

  const activeBlock = useMemo(() => blocks.find((block) => block.blockId === activeBlockId), [activeBlockId, blocks]);
  const activeBlockIndex = useMemo(() => blocks.findIndex((block) => block.blockId === activeBlockId), [activeBlockId, blocks]);
  const canFormat = Boolean(activeBlock && textBlockTypes.has(activeBlock.type));

  const replaceBlock = (blockId: string, next: PostBlock) => {
    onChange(blocks.map((block) => block.blockId === blockId ? next : block));
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
    const activeIndex = blocks.findIndex((item) => item.blockId === activeBlockId);
    const insertAt = activeIndex >= 0 ? activeIndex + 1 : blocks.length;
    const next = [...blocks];
    next.splice(insertAt, 0, block);
    onChange(next);
    setActiveBlockId(block.blockId);
    window.setTimeout(() => editableRefs.current.get(block.blockId)?.focus(), 0);
  };

  const addMediaBlock = (mediaId: string) => {
    const media = mediaOptions.find((item) => item.mediaId === mediaId);
    if (!media) return;
    const block: PostBlock = {
      blockId: typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `block-${Date.now()}`,
      type: media.assetType || 'image',
      mediaId,
      ...(media.assetType === 'file' ? { label: media.label, mimeType: media.mimeType } : {}),
      caption: ''
    };
    const activeIndex = blocks.findIndex((item) => item.blockId === activeBlockId);
    const next = [...blocks];
    next.splice(activeIndex >= 0 ? activeIndex + 1 : blocks.length, 0, block);
    onChange(next);
    setActiveBlockId(block.blockId);
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
        {!readOnly && <div className="portable-block-editor-toolbar" aria-label="Active block tools">
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
          </div>
          <button type="button" className="portable-block-editor-remove" disabled={!activeBlock} onClick={() => activeBlock && removeBlock(activeBlock.blockId)}>Remove block</button>
        </div>}

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
                <label>Section title<input value={block.title || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, title: event.target.value })} /></label>
                <BlockEditor value={block.blocks || []} readOnly={readOnly} mediaOptions={mediaOptions} allowMedia={allowMedia} allowStructured={allowStructured}
                  label={block.title || 'Section'} onChange={next => replaceBlock(block.blockId, { ...block, blocks: next })} />
              </div>}
              {block.type === 'link' && <div>
                <label>Link label<input value={block.label || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, label: event.target.value })} /></label>
                <label>Link URL<input value={block.url || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, url: event.target.value })} /></label>
              </div>}
              {block.type === 'credit' && <div>
                <label>Credit author<input value={block.author || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, author: event.target.value })} /></label>
                <label>Credit text<textarea value={block.text || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, text: event.target.value })} /></label>
                <label>Credit URL<input value={block.url || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, url: event.target.value })} /></label>
              </div>}
              {!isTextBlock && !['section', 'divider', 'image', 'video', 'audio', 'file', 'link', 'credit'].includes(block.type) && <p>Preserved {block.type} block — dedicated controls are not available yet.</p>}
              {block.type === 'file' && <div className="portable-block-editor-file">
                <p>Attached file: {media?.label || block.label || block.fileId || block.mediaId || 'Unavailable reference'}</p>
                <label>File label<input value={block.label || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, label: event.target.value })} /></label>
                <label>Caption<input value={block.caption || ''} readOnly={readOnly} onChange={event => replaceBlock(block.blockId, { ...block, caption: event.target.value })} /></label>
                <small>File contents are not displayed here. Downloads require the application's authorized attachment route.</small>
              </div>}
              {(block.type === 'image' || block.type === 'video' || block.type === 'audio') && <div className="portable-block-editor-media">
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
          <button type="button" onClick={() => addTextBlock('heading')}>Heading</button>
          <button type="button" onClick={() => addTextBlock('quote')}>Quote</button>
          <button type="button" onClick={() => addTextBlock('divider')}>Divider</button>
          {allowStructured && <>
            <button type="button" onClick={() => addTextBlock('section')}>Section</button>
            <button type="button" onClick={() => addTextBlock('link')}>Link block</button>
            <button type="button" onClick={() => addTextBlock('credit')}>Credit</button>
          </>}
          {allowMedia && mediaOptions.length > 0 && <select defaultValue="" onChange={(event) => {
            addMediaBlock(event.target.value);
            event.target.value = '';
          }} aria-label="Add media block">
            <option value="">Add attached media or file…</option>
            {mediaOptions.map((media) => <option key={media.mediaId} value={media.mediaId}>{media.label}</option>)}
          </select>}
        </div>}
      </div>
    </div>
  );
}
