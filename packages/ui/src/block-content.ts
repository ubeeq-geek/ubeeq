import type { StoredPostBlock as PostBlock } from '@ubeeq/core';
import { parseFragment, serialize, serializeOuter, type DefaultTreeAdapterMap } from 'parse5';

export type DescriptionBlockType = 'paragraph' | 'heading' | 'quote' | 'divider';

const descriptionBlockTypes = new Set<PostBlock['type']>(['paragraph', 'heading', 'quote', 'divider']);

const createBlockId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `block-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const isSafeLink = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
};

/** One inert HTML parser for server and browser. Reconstruct only the inline allowlist;
 * never serialize source nodes or attributes. Input and visited-node budgets fail closed.
 */
const inlineContent = (value: string, plainText: boolean, preserveLists = false, resetFormatting = false): string => {
  if (!value) return '';
  if (value.length > 1_048_576) throw new Error('Inline content exceeds its input budget.');
  const root = parseFragment(value);
  const stack: Array<DefaultTreeAdapterMap['node'] | string> = [...root.childNodes].reverse();
  const output: string[] = [];
  // HTML parsing replaces null characters in source text, so this internal
  // marker cannot collide with text supplied by the editor.
  const paragraphBoundary = '\u0000paragraph\u0000';
  let visited = 0;const listCounts=new Map<object,number>();
  while (stack.length) {
    const node = stack.pop()!;
    if (typeof node === 'string') { output.push(node); continue; }
    if (++visited > 50_000) throw new Error('Inline content exceeds its structure budget.');
    if (node.nodeName === '#text' && 'value' in node) { output.push(plainText ? node.value : escapeHtml(node.value).replace(/\r\n?|\n/g, '<br>')); continue; }
    if (!('tagName' in node) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
    const tag = node.tagName;
    if (['script', 'style', 'template', 'iframe', 'object', 'embed', 'noscript'].includes(tag)) continue;
    if (tag === 'br') { output.push(plainText ? '\n' : '<br>'); continue; }
    let start = '', end = '';
    if (tag === 'div' || tag === 'p') { start = paragraphBoundary; end = paragraphBoundary; }
    else if (plainText && tag === 'li') { const parent=node.parentNode;const ordered=parent&&'tagName' in parent&&parent.tagName==='ol';const index=parent?(listCounts.get(parent)??0)+1:1;if(parent)listCounts.set(parent,index);const letters=ordered&&parent&&'attrs' in parent&&parent.attrs.some(attr=>attr.name==='type'&&attr.value==='a');const dashes=parent&&'attrs' in parent&&parent.attrs.some(attr=>attr.name==='data-list-marker'&&attr.value==='dashes');let label='';for(let number=index;number>0;number=Math.floor((number-1)/26))label=String.fromCharCode(97+(number-1)%26)+label;start=ordered?`${letters?label:index}. `:dashes?'– ':'• ';end='\n'; }
    else if (!plainText) {
      const normalized = ({ b: 'strong', strong: 'strong', i: 'em', em: 'em', u: 'u', s: 's', strike: 's', code: 'code' } as Record<string, string>)[tag];
      if (normalized && !resetFormatting) { start = '<' + normalized + '>'; end = '</' + normalized + '>'; }
      else if (preserveLists && ['ol','ul','li'].includes(tag)) { const marker=!resetFormatting&&tag==='ol'&&node.attrs.some(attr=>attr.name==='type'&&attr.value==='a')?' type="a"':!resetFormatting&&tag==='ul'&&node.attrs.some(attr=>attr.name==='data-list-marker'&&attr.value==='dashes')?' data-list-marker="dashes"':'';start='<'+tag+marker+'>';end='</'+tag+'>'; }
      else if (tag === 'li') { start = '• '; end = '<br>'; }
      else if (tag === 'a') {
        const href = node.attrs.find(attribute => attribute.name === 'href')?.value || '';
        if (isSafeLink(href)) { start = '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">'; end = '</a>'; }
      }
    }
    output.push(start);
    if (end) stack.push(end);
    for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push(node.childNodes[index]);
  }
  const content = output.join('');
  if (!content.includes(paragraphBoundary)) return content;
  return content.split(paragraphBoundary)
    .map(part => plainText ? part.replace(/^\n+|\n+$/g, '') : part.replace(/^(?:<br>)+|(?:<br>)+$/g, ''))
    .filter(part => part.trim())
    .join(plainText ? '\n\n' : '<br><br>');
};

export const sanitizeInlineHtml = (value: string): string => inlineContent(value, false);
export const inlineHtmlToText = (value: string): string => inlineContent(value, true);

/** Lists remain paragraph blocks with an explicit presentation, preserving existing storage contracts. */
export const blockListStyle = (block: Pick<PostBlock,'type'|'payload'>): 'ordered'|'unordered'|undefined => block.type==='paragraph'&&(block.payload?.listStyle==='ordered'||block.payload?.listStyle==='unordered')?block.payload.listStyle:undefined;
export type ListMarker = 'numbers'|'letters'|'dashes'|'dots';
export const blockListMarker = (block:Pick<PostBlock,'type'|'payload'>):ListMarker => {
  const ordered=blockListStyle(block)==='ordered';
  return ordered?(block.payload?.listMarker==='letters'?'letters':'numbers'):(block.payload?.listMarker==='dashes'?'dashes':'dots');
};
export const sanitizeListHtml = (value:string,style:'ordered'|'unordered',marker?:ListMarker):string => {
  const safe=inlineContent(value,false,true),root=parseFragment(safe),items:string[]=[];let pending:string[]=[];
  const nesting=root.childNodes.map(node=>({node,depth:1}));while(nesting.length){const {node,depth}=nesting.pop()!;if(depth>128)throw new Error('List content exceeds its nesting limit.');if('childNodes' in node)for(const child of node.childNodes)nesting.push({node:child,depth:depth+1});}
  const flush=()=>{const content=pending.join('');if(content.trim())items.push('<li>'+content+'</li>');pending=[];};
  for(const node of root.childNodes){
    if('tagName' in node&&['ol','ul'].includes(node.tagName)){flush();for(const child of node.childNodes)if('tagName' in child&&child.tagName==='li')items.push(serializeOuter(child));}
    else if('tagName' in node&&node.tagName==='li'){flush();items.push(serializeOuter(node));}
    else pending.push(serializeOuter(node));
  }
  flush();const tag=style==='ordered'?'ol':'ul';const attributes=style==='ordered'&&marker==='letters'?' type="a"':style==='unordered'&&marker==='dashes'?' data-list-marker="dashes"':'';return `<${tag}${attributes}>${items.join('')||'<li><br></li>'}</${tag}>`;
};
export const textBlockHtml = (block:Pick<PostBlock,'type'|'payload'|'html'|'text'|'quote'>):string => {
  const value=block.html??textToInlineHtml(block.quote||block.text||''),style=blockListStyle(block);
  return style?sanitizeListHtml(value,style,blockListMarker(block)):sanitizeInlineHtml(value);
};
/** Reset presentation overrides while retaining content, links and semantic block types. */
export function resetBlockPresentation(block:PostBlock):PostBlock {
  const payload={...block.payload};
  if(['paragraph','heading','quote'].includes(block.type)){
    delete payload.textAlign;delete payload.listMarker;
    const clean=inlineContent(block.html??textToInlineHtml(block.quote||block.text||''),false,true,true);
    const next={...block,payload,html:clean};
    const html=textBlockHtml(next),text=inlineHtmlToText(html);
    return {...next,html,text,...(block.type==='quote'?{quote:text}:{})};
  }
  if(block.type==='image')for(const field of ['alignment','textFlow','desktopWidth','mobileWidth'])delete payload[field];
  if(block.type==='link')delete payload.appearance;
  return {...block,payload};
}
export const createListBlock = (style:'ordered'|'unordered'):PostBlock => ({...createDescriptionBlock(),payload:{listStyle:style},html:sanitizeListHtml('',style)});

export const textToInlineHtml = (value: string): string => escapeHtml(value).replace(/\r\n?|\n/g, '<br>');

export const createDescriptionBlock = (type: DescriptionBlockType = 'paragraph'): PostBlock => ({
  blockId: createBlockId(),
  type,
  ...(type === 'heading' ? { level: 2 } : {}),
  ...(type !== 'divider' ? { text: '', html: '' } : {})
});

/** Work-body blocks, not compatible with the description-only serializer. */
export const createStructuredBlock = (type: 'section' | 'link' | 'credit'): PostBlock => {
  if (!['section', 'link', 'credit'].includes(type)) throw new Error('Unsupported structured block type.');
  return { blockId: createBlockId(), type,
    ...(type === 'section' ? { title: '', blocks: [] } : type === 'link' ? { label: '', url: '' } : { author: '', text: '', url: '' }) };
};

const blockFromElement = (element: DefaultTreeAdapterMap['element']): PostBlock | null => {
  const tag = element.tagName;
  if (tag === 'hr') return createDescriptionBlock('divider');
  if(tag==='ol'||tag==='ul'){const block=createListBlock(tag==='ol'?'ordered':'unordered');const marker=tag==='ol'&&element.attrs.some(attr=>attr.name==='type'&&attr.value==='a')?'letters':tag==='ul'&&element.attrs.some(attr=>attr.name==='data-list-marker'&&attr.value==='dashes')?'dashes':undefined;if(marker)block.payload={...block.payload,listMarker:marker};block.html=sanitizeListHtml(serializeOuter(element),blockListStyle(block)!,marker);block.text=inlineHtmlToText(block.html).trim();return block;}
  const html = sanitizeInlineHtml(serialize(element));
  const text = inlineHtmlToText(html).trim();
  if (!text && !html.includes('<br>')) return null;
  if (/^h[1-6]$/.test(tag)) {
    return { ...createDescriptionBlock('heading'), level: Number(tag.slice(1)), text, html };
  }
  if (tag === 'blockquote') {
    return { ...createDescriptionBlock('quote'), text, quote: text, html };
  }
  return { ...createDescriptionBlock('paragraph'), text, html };
};

export const parseDescriptionBlocks = (value?: string): PostBlock[] => {
  const source = value?.trim() || '';
  if (source.length > 1_048_576) throw new Error('Description exceeds its input budget.');
  if (!source) return [createDescriptionBlock()];
  if (!/<\/?[a-z][^>]*>/i.test(source)) {
    return source.split(/\n\s*\n+/).filter(Boolean).map((text) => ({
      ...createDescriptionBlock(),
      text,
      html: textToInlineHtml(text)
    }));
  }
  const document = parseFragment(source);
  // Serialization is recursive; reject excessive depth before serializing any node.
  const pending = document.childNodes.map(node => ({ node, depth: 1 }));
  let visited = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++visited > 50_000 || depth > 256) throw new Error('Description exceeds its structure budget.');
    if ('childNodes' in node) for (const child of node.childNodes) pending.push({ node: child, depth: depth + 1 });
  }
  const blocks: PostBlock[] = [];
  let inlineNodes: DefaultTreeAdapterMap['childNode'][] = [];
  const flushInlineNodes = () => {
    if (!inlineNodes.length) return;
    const html = sanitizeInlineHtml(inlineNodes.map(node => serializeOuter(node)).join(''));
    const text = inlineHtmlToText(html).trim();
    if (text || html.includes('<br>')) blocks.push({ ...createDescriptionBlock(), text, html });
    inlineNodes = [];
  };

  document.childNodes.forEach((node) => {
    if ('tagName' in node && node.namespaceURI === 'http://www.w3.org/1999/xhtml' && /^(p|div|h[1-6]|blockquote|hr|section|article|ul|ol)$/.test(node.tagName)) {
      flushInlineNodes();
      const block = blockFromElement(node);
      if (block) blocks.push(block);
      return;
    }
    inlineNodes.push(node);
  });
  flushInlineNodes();

  return blocks.length ? blocks : [createDescriptionBlock()];
};

const inlineHtmlForBlock = textBlockHtml;

export const normalizeDescriptionBlocks = (blocks: PostBlock[]): PostBlock[] => blocks
  .filter((block) => descriptionBlockTypes.has(block.type))
  .map((block) => {
    if (block.type === 'divider') return { blockId: block.blockId || createBlockId(), type: 'divider' };
    const html = inlineHtmlForBlock(block);
    const text = inlineHtmlToText(html);
    return {
      blockId: block.blockId || createBlockId(),
      type: block.type,
      ...(blockListStyle(block)?{payload:{listStyle:blockListStyle(block),...(block.payload?.listMarker?{listMarker:blockListMarker(block)}:{})}}:{}),
      ...(block.type === 'heading' ? { level: Math.max(1, Math.min(6, block.level || 2)) } : {}),
      ...(block.type === 'quote' ? { quote: text } : {}),
      text,
      html
    };
  });

export const serializeDescriptionBlocks = (
  blocks: PostBlock[],
  options: { maxHeadingLevel?: number } = {}
): string => normalizeDescriptionBlocks(blocks).map((block) => {
  if (block.type === 'divider') return '<hr>';
  const html = inlineHtmlForBlock(block);
  if (!inlineHtmlToText(html).trim() && !html.includes('<br>')) return '';
  if (block.type === 'heading') {
    const level = Math.max(1, Math.min(options.maxHeadingLevel ?? 6, block.level || 2));
    return `<h${level}>${html}</h${level}>`;
  }
  if (block.type === 'quote') return `<blockquote>${html}</blockquote>`;
  if (blockListStyle(block)) return html;
  return `<p>${html}</p>`;
}).filter(Boolean).join('');

export const clonePostBlocks = <T extends PostBlock>(blocks: T[]): T[] => structuredClone(blocks);

/** Change text presentation without dropping IDs, nested content or extension metadata. */
export const changeTextBlockType = (block: PostBlock, type: 'paragraph' | 'heading' | 'quote'): PostBlock => {
  const supported = new Set(['paragraph', 'heading', 'quote']);
  if (!supported.has(block.type) || !supported.has(type)) throw new Error('Only text blocks support text type changes.');
  const next = structuredClone(block);
  const html = block.html !== undefined ? block.html : textToInlineHtml(block.quote || block.text || '');
  next.type = type;
  next.html = html;
  next.text = inlineHtmlToText(html);
  delete next.level; delete next.quote;
  if (type === 'heading') next.level = block.type === 'heading' ? block.level || 2 : 2;
  if (type === 'quote') next.quote = next.text;
  return next;
};

/** Reorder whole top-level subtrees; input blocks remain isolated from the result. */
export const movePostBlock = (blocks: PostBlock[], blockId: string, direction: -1 | 1): PostBlock[] => {
  const index = blocks.findIndex(block => block.blockId === blockId);
  if (index < 0 || (direction !== -1 && direction !== 1)) throw new Error('Invalid block move.');
  const next = clonePostBlocks(blocks), target = index + direction;
  if (target >= 0 && target < next.length) [next[index], next[target]] = [next[target], next[index]];
  return next;
};

/** Section names identify fragment links, not visible headings. */
export function websiteSectionSlug(value:unknown):string {
  if(typeof value!=='string')return '';
  const slug=value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,100);
  return slug&&(!/^[a-z]/.test(slug)||slug==='main'||/^heading-\d+$/.test(slug))?'section-'+slug:slug;
}
export function websiteSectionAnchors(blocks:readonly PostBlock[]):Map<string,string> {
  const anchors=new Map<string,string>(),used=new Set<string>();let sectionNumber=0;
  const visit=(items:readonly PostBlock[])=>{for(const block of items){
    if(block.type==='section'){
      sectionNumber++;
      const base=websiteSectionSlug(block.payload?.anchor??block.title)||`section${sectionNumber}`;
      if(base){let slug=base,n=2;while(used.has(slug))slug=base+'-'+n++;used.add(slug);anchors.set(block.blockId,slug);}
    }
    if(block.blocks)visit(block.blocks);
  }};
  visit(blocks);return anchors;
}

/** Promote website subsections without dropping content or changing its reading order. */
export function flattenWebsiteSections(blocks: PostBlock[]): PostBlock[] {
  const used = new Set<string>();
  const collect = (items: PostBlock[]) => { for (const item of items) { used.add(item.blockId); if (item.blocks) collect(item.blocks); } };
  collect(blocks);
  const result: PostBlock[] = [];
  const visit = (block: PostBlock) => {
    if (block.type !== 'section') { result.push(block); return; }
    let current: PostBlock | undefined = { ...block, blocks: [] };
    result.push(current);
    let part = 0;
    for (const child of block.blocks ?? []) {
      if (child.type === 'section') { visit(child); current = undefined; }
      else {
        if (!current) {
          let id: string;
          do { id = `${block.blockId}-continued-${++part}`; } while (used.has(id));
          used.add(id);
          current = { ...block, blockId: id, title: block.title ? `${block.title} (continued)` : '', blocks: [] };
          result.push(current);
        }
        current.blocks!.push(child);
      }
    }
  };
  for (const block of blocks) visit(block);
  const sections: PostBlock[] = [];
  const isGallery = (block: PostBlock | undefined) => block && ['gallery_list','selected_portfolio'].includes(block.type);
  for (let index=0;index<result.length;index++) {
    const block=result[index],next=result[index+1];
    if (block.type==='heading' && (block.level??2)===2 && isGallery(next)) {
      let id=block.blockId+'-section';while(used.has(id))id+='-section';used.add(id);
      sections.push({blockId:id,type:'section',title:block.text || inlineHtmlToText(block.html || '') || 'Galleries',blocks:[block,next],payload:{presentation:'standard'}});
      index++;
    } else if (isGallery(block)) {
      let id=block.blockId+'-section';
      while(used.has(id))id+='-section';
      used.add(id);
      sections.push({blockId:id,type:'section',title:'Galleries',blocks:[block],payload:{presentation:'standard'}});
    } else sections.push(block);
  }
  return sections;
}

/** Split explicit line breaks while balancing formatting/link tags on every new paragraph. */
export function splitParagraphBlock(block:PostBlock):PostBlock[] {
  if(block.type!=='paragraph')return [block];
  const root=parseFragment(sanitizeInlineHtml(block.html??textToInlineHtml(block.text??'')));
  const pending:Array<DefaultTreeAdapterMap['node']|{end:true}>=[...root.childNodes].reverse();
  const tags:Array<{open:string;close:string}>=[],lines:string[]=[];let current='',size=0;
  const finish=()=>{
    const html=current+tags.map(tag=>tag.close).reverse().join('');
    if(inlineHtmlToText(html).trim()){size+=html.length;if(size>1_048_576||lines.length>=1000)throw new Error('Split fewer than 1,000 lines at a time.');lines.push(html);}
    current=tags.map(tag=>tag.open).join('');
  };
  while(pending.length){
    const node=pending.pop()!;
    if('end' in node){current+=tags.pop()!.close;continue;}
    if(node.nodeName==='#text'&&'value' in node){current+=escapeHtml(node.value);continue;}
    if(!('tagName' in node))continue;
    if(node.tagName==='br'){finish();continue;}
    const serialized=serializeOuter(node),open=serialized.slice(0,serialized.indexOf('>')+1),close='</'+node.tagName+'>';
    current+=open;tags.push({open,close});pending.push({end:true});
    for(let index=node.childNodes.length-1;index>=0;index--)pending.push(node.childNodes[index]);
  }
  finish();
  if(lines.length<2)return [block];
  return lines.map((html,index)=>({...block,blockId:index?createBlockId():block.blockId,html,text:inlineHtmlToText(html)}));
}
