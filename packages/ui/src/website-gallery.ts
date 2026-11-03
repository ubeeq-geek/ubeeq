import {websiteExternalUrl} from '@ubeeq/core';
import {galleryLinkPlatforms} from './gallery-link-platforms.js';

export interface WebsiteViewerGallery {
  id:string;title:string;href:string;
  cover?:{src:string;alt:string};
  downloads?:readonly {label:string;assetId:string}[];
  photos:readonly {src:string;thumbnail:string;alt:string;title?:string;workHref?:string;originalAssetId?:string;downloadAssetId?:string}[];
  externalLinksText?:string;externalLinks?:readonly {label:string;url:string}[];
  purchaseText?:string;purchaseLinks?:readonly {label:string;url:string;priceText?:string}[];
}
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Group by the validated URL's platform, never by a user-supplied label. */
export function renderWebsiteGalleryLinks(gallery: Pick<WebsiteViewerGallery,'purchaseText'|'purchaseLinks'|'externalLinksText'|'externalLinks'>):string {
 const e=escape;
 return ([['purchase','Purchase links',gallery.purchaseText?.trim()||'Want more?',gallery.purchaseLinks],['additional','Additional Platform Links',gallery.externalLinksText?.trim()||'Also available on:',gallery.externalLinks]] as const).map(([kind,name,heading,links])=>{
  if(!links?.length)return '';
  const groups=new Map<string,{name:string;path?:string;viewBox?:string;links:{label:string;url:string;priceText?:string}[]}>();
  for(const link of links){
   const url=websiteExternalUrl(link.url),host=new URL(url).hostname.toLowerCase().replace(/^www\./,'');
   const platform=galleryLinkPlatforms.find(p=>p.domains.some(domain=>host===domain||host.endsWith('.'+domain)));
   const key=platform?.name??host,group=groups.get(key)??{name:key,path:platform&&'path' in platform?platform.path:undefined,viewBox:platform&&'viewBox' in platform?platform.viewBox:undefined,links:[]};
   group.links.push({...link,url});groups.set(key,group);
  }
  const buttons=[...groups.values()].map(group=>{
   const icon=`<svg viewBox="${group.viewBox??'0 0 24 24'}" width="22" height="22" aria-hidden="true" focusable="false">${group.path?`<path fill="currentColor" d="${group.path}"/>`:'<g fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 6.5h14M5 17.5h14"/></g>'}</svg>`;
   const label=(link:{label:string;priceText?:string})=>link.label+(link.priceText?' · '+link.priceText:'');
   if(group.links.length===1){const link=group.links[0],text=label(link);return `<a class="website-gallery-platform-link" href="${e(link.url)}" target="_blank" rel="noopener noreferrer" aria-label="${e(group.name+': '+text)}">${icon}<span class="website-gallery-link-tooltip">${e(text)}</span></a>`;}
   return `<details class="website-gallery-platform-menu"><summary aria-label="${e(group.name)} · ${group.links.length} links" title="${e(group.name)}">${icon}<svg class="website-gallery-link-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="2"/></svg></summary><div class="website-gallery-link-options">${group.links.map(link=>`<a href="${e(link.url)}" target="_blank" rel="noopener noreferrer">${e(label(link))}</a>`).join('')}</div></details>`;
  }).join('');
  return `<div class="website-gallery-link-group" data-link-kind="${kind}" role="group" aria-label="${e(name)}"><p class="website-gallery-link-heading">${e(heading)}</p><div class="website-gallery-link-icons">${buttons}</div></div>`;
 }).join('');
}
/** Also invalidate saved exports when icon definitions or link rendering changes. */
export const websiteGalleryLinksFingerprintInput=JSON.stringify(galleryLinkPlatforms)+renderWebsiteGalleryLinks.toString();

const galleryDownloadButtons=(gallery:WebsiteViewerGallery)=>gallery.downloads?.length?`<div class="website-gallery-downloads" role="group" aria-label="Collection downloads">${gallery.downloads.map(link=>`<button type="button" data-gallery-download="${escape(link.assetId)}">${escape(link.label)}</button>`).join('')}</div>`:'';
export function renderWebsiteGalleryGroup(entries:readonly WebsiteViewerGallery[],selectedId?:string){
 const e=escape,selected=entries.find(g=>g.id===selectedId),count=(n:number)=>`${n} image${n===1?'':'s'}`;
 const tiles=selected?selected.photos.map((photo,index)=>`<a class="website-gallery-tile" href="${e(photo.workHref??selected.href)}" data-gallery-open="${e(selected.id)}" data-photo-index="${index}"><span class="website-gallery-cover"><img src="${e(photo.src)}" alt="${e(photo.alt)}" loading="lazy"><span class="website-gallery-view">View image</span></span><span class="website-gallery-tile-title">${e(photo.title??photo.alt)}</span></a>`).join(''):entries.map(g=>`<article class="website-gallery-teaser"><a class="website-gallery-tile" href="${e(g.href)}" data-gallery-open="${e(g.id)}"><span class="website-gallery-cover">${g.cover||g.photos[0]?`<img src="${e((g.cover??g.photos[0]).src)}" alt="${e(g.cover?.alt??'')}" loading="lazy">`:'<span class="website-gallery-empty-cover">No preview image</span>'}<span class="website-gallery-count">${count(g.photos.length)}</span><span class="website-gallery-view">▶ View gallery</span></span><span class="website-gallery-tile-title">${e(g.title)}</span></a><p class="website-gallery-tile-count">${count(g.photos.length)}</p>${renderWebsiteGalleryLinks(g)}</article>`).join('');
 const icon=(content:string)=>`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${content}</svg>`;
 const playIcon=icon('<path data-icon="play" d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/><g data-icon="pause"><path d="M8 5v14M16 5v14" stroke-width="4"/></g>');
 const fullscreenIcon=icon('<path data-icon="expand" d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><path data-icon="contract" d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>');
 const helpIcon=icon('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 16h.01"/>');
 const closeIcon=icon('<path d="m6 6 12 12M6 18 18 6"/>');
 const purchase=selected?`<div class="website-gallery-static-purchase">${renderWebsiteGalleryLinks(selected)}</div>`:'';
 const nonempty=entries.filter(g=>g.photos.length),first=nonempty[0];
 const endNote=selected&&first&&selected.id===nonempty.at(-1)?.id?`<section class="website-gallery-end-note" aria-label="End of galleries"><p>You’ve reached the end of these galleries.</p><a href="${e(first.href)}">Back to first gallery</a></section>`:'';
 const data=entries.map(g=>`<div data-gallery-entry="${e(g.id)}"><h3 data-gallery-title>${e(g.title)}</h3><div data-gallery-links>${renderWebsiteGalleryLinks(g)}${galleryDownloadButtons(g)}</div>${g.photos.map(p=>`<figure data-gallery-photo${p.originalAssetId?` data-original-asset="${e(p.originalAssetId)}"`:""}${p.downloadAssetId?` data-download-asset="${e(p.downloadAssetId)}"`:""}${p.title?` data-photo-title="${e(p.title)}"`:""}><img data-gallery-full data-src="${e(p.src)}" alt="${e(p.alt)}" loading="lazy"><img data-gallery-thumb data-src="${e(p.thumbnail)}" alt="" loading="lazy"></figure>`).join('')}</div>`).join('');
 return `<section class="website-gallery-group" data-gallery-root><div class="website-gallery-tiles">${tiles||'<p>No images are available in this gallery yet.</p>'}</div>${endNote}${purchase}<div hidden data-gallery-data>${data}</div><dialog class="website-gallery-viewer" data-gallery-dialog tabindex="-1" aria-label="Gallery viewer"><div class="website-gallery-surface" data-gallery-surface><div class="website-gallery-viewer-header"><div class="website-gallery-heading"><button type="button" data-action="previous-gallery" aria-label="Previous gallery">‹</button><div><h2 data-viewer-title></h2><p><span data-gallery-position></span> · Photo <span data-image-counter></span></p></div><button type="button" data-action="next-gallery"></button></div><div class="website-gallery-controls"><button type="button" class="website-gallery-icon-button" data-action="play" aria-pressed="false" aria-label="Play slideshow" title="Play slideshow">${playIcon}</button><select data-gallery-interval aria-label="Slide duration"><option value="2">2s</option><option value="3">3s</option><option value="4" selected>4s</option><option value="6">6s</option><option value="10">10s</option></select><button type="button" class="website-gallery-icon-button" data-action="fullscreen" aria-pressed="false" aria-label="Full screen" title="Full screen">${fullscreenIcon}</button><div class="website-gallery-help-control"><button type="button" class="website-gallery-icon-button" data-action="help" aria-expanded="false" aria-label="Gallery help" title="Gallery help">${helpIcon}</button><section class="website-gallery-help-panel" data-gallery-help role="region" aria-label="Gallery help" hidden><h3>Using the gallery</h3><p>Click the right side of the photo, scroll, or swipe left for the next image. Click the left side or swipe right to go back.</p><dl><dt>← / →</dt><dd>Previous / next image</dd><dt>↑ / ↓</dt><dd>Previous / next gallery</dd><dt>Space</dt><dd>Play or pause the slideshow when the viewer is focused</dd><dt>F</dt><dd>Enter or exit full screen</dd><dt>Esc</dt><dd>Dismiss help, exit full screen, or close the viewer</dd></dl><p>Choose a duration beside Play to set the slideshow speed. Select a thumbnail to jump to an image.</p><button type="button" data-action="close-help">Close help</button></section></div><button type="button" class="website-gallery-icon-button" data-action="close" aria-label="Close gallery viewer" title="Close gallery viewer">${closeIcon}</button></div></div><div class="website-gallery-progress"><span data-slide-progress></span></div><nav class="website-gallery-purchase" data-purchase-section aria-label="Gallery links" hidden></nav><div class="website-gallery-stage" data-gallery-stage><img data-viewer-image alt=""><section class="website-gallery-end" data-gallery-end hidden aria-label="End of galleries"><h3>You’ve reached the end of these galleries.</h3><p>Start again from the first gallery whenever you’re ready.</p><button type="button" data-action="restart">Back to first gallery</button></section><button type="button" class="website-gallery-stage-prev" data-action="previous" aria-label="Previous image">‹</button><button type="button" class="website-gallery-stage-next" data-action="next" aria-label="Next image">›</button><button type="button" class="website-gallery-intro" data-action="start" hidden><img data-intro-cover alt=""><span><small>Up next</small><strong data-intro-title></strong><span data-intro-count></span><span class="website-gallery-intro-progress"><span data-intro-progress></span></span><small>Click or press → to start now</small></span></button></div><div class="website-gallery-caption-area"><p class="website-gallery-caption" data-image-caption></p></div><div class="website-gallery-thumbnails" data-gallery-thumbnails role="group" aria-label="Choose an image"></div><p class="website-gallery-announcement" role="status" aria-live="polite" data-viewer-status></p></div></dialog></section>`;
}

/** Loads thumbnail pages only after the focused image, with at most six requests per batch. */
export function createGalleryThumbnailLoader(primary:HTMLImageElement,strip:HTMLElement,images:readonly HTMLImageElement[],focusIndex:number,isActive:()=>boolean,onReady?:()=>void){
 let disposed=false,ready=false,busy=false;const started=new Set<number>(),queued:number[]=[],cleanup:Array<()=>void>=[];
 const valid=()=>!disposed&&isActive();
 const visible=()=>{if(!ready||!valid())return;const left=strip.scrollLeft,right=left+strip.clientWidth;for(let i=0;i<images.length;i++){const tile=images[i].parentElement;if(tile&&tile.offsetLeft+tile.offsetWidth>left&&tile.offsetLeft<right)enqueue(i);}pump();};
 const enqueue=(index:number)=>{const page=Math.floor(index/6)*6;if(!queued.includes(page)&&images.slice(page,page+6).some((_,i)=>!started.has(page+i)))queued.push(page);};
 const pump=()=>{if(!ready||busy||!valid())return;let page:number|undefined;while(queued.length){const candidate=queued.shift()!;if(images.slice(candidate,candidate+6).some((_,i)=>!started.has(candidate+i))){page=candidate;break;}}if(page===undefined)return;
  const pending=images.slice(page,page+6).map((image,i)=>({image,index:page!+i})).filter(item=>!started.has(item.index));busy=true;let remaining=pending.length;
  for(const {image,index}of pending){started.add(index);let settled=false;const done=()=>{if(settled)return;settled=true;image.removeEventListener('load',done);image.removeEventListener('error',done);if(--remaining===0){busy=false;if(valid())visible();}};image.addEventListener('load',done);image.addEventListener('error',done);cleanup.push(()=>{image.removeEventListener('load',done);image.removeEventListener('error',done);});image.loading='eager';image.fetchPriority='low';if(image.getAttribute('src')!==image.dataset.thumbnailSrc)image.src=image.dataset.thumbnailSrc!;if(image.complete)done();}
 };
 const loaded=()=>{if(!valid()||!primary.complete||primary.naturalWidth===0||primary.currentSrc&&primary.currentSrc!==primary.src)return;if(!ready){ready=true;onReady?.();enqueue(focusIndex);}pump();visible();};
 primary.addEventListener('load',loaded);strip.addEventListener('scroll',visible,{passive:true});loaded();
 return {focus(index:number){ready=false;focusIndex=index;queued.length=0;loaded();},dispose(){disposed=true;primary.removeEventListener('load',loaded);strip.removeEventListener('scroll',visible);for(const remove of cleanup)remove();}};
}

/** Trusted static source stays identical in server exports and minified browser previews. */
export const websiteGalleryViewerScript=
"(function websiteGalleryViewerRuntime() {\n"
+ "    const createThumbnailLoader="+createGalleryThumbnailLoader.toString()+";\n"
+ "    for (const [rootIndex,root] of Array.from(document.querySelectorAll('[data-gallery-root]')).entries()) {\n"
+ "        const dialog = root.querySelector('[data-gallery-dialog]');\n"
+ "        if (!dialog || typeof dialog.showModal !== 'function')\n"
+ "            continue;\n"
+ "        const entries = Array.from(root.querySelectorAll('[data-gallery-entry]')).map(node => ({ id: node.dataset.galleryEntry, title: node.querySelector('[data-gallery-title]')?.textContent ?? 'Gallery', linkGroups: node.querySelector('[data-gallery-links]'), photos: Array.from(node.querySelectorAll('[data-gallery-photo]')).map(figure => { const full = figure.querySelector('[data-gallery-full]'), thumb = figure.querySelector('[data-gallery-thumb]'); return { src: full.getAttribute('data-src')??full.getAttribute('src'), thumbnail: thumb.getAttribute('data-src')??thumb.getAttribute('src'), alt: full.alt, title: figure.dataset.photoTitle, downloadAssetId: figure.dataset.downloadAsset,originalAssetId:figure.dataset.originalAsset }; }) })).filter(g => g.photos.length);\n"
+ "        if (!entries.length)\n"
+ "            continue;\n"
+ "        for (const opener of root.querySelectorAll('[data-gallery-open]'))\n"
+ "            if (entries.some(g => g.id === opener.dataset.galleryOpen))\n"
+ "                opener.setAttribute('aria-haspopup', 'dialog');\n"
+ "        const get = (selector) => dialog.querySelector(selector);\n"
+ "        let linksGallery = -1, gallery = 0, index = 0, playing = false, timer, intro = false, ended = false, opener, overflow = '', lastWheel = 0, pointer, thumbnailLoader, thumbnailGallery=-1;\n"
+ "        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;\n"
+ "        const stop = () => { clearTimeout(timer); timer = undefined; };\n"
+ "        const schedule = () => {\n"
+ "            const imageReady=get('[data-viewer-image]').complete&&get('[data-viewer-image]').naturalWidth>0;\n"
+ "            for(const [selector,enabled,duration] of [['[data-slide-progress]',playing&&imageReady&&!intro,Number(get('[data-gallery-interval]').value)*1000],['[data-intro-progress]',playing&&imageReady&&intro,2500]]){const bar=get(selector);for(const animation of bar.getAnimations())animation.cancel();bar.style.transform='scaleX(0)';if(enabled)bar.animate([{transform:'scaleX(0)'},{transform:'scaleX(1)'}],{duration,fill:'forwards'});}\n"
+ " stop(); if (playing && dialog.open && !ended && imageReady)\n"
+ "            timer = setTimeout(() => { if (intro) {\n"
+ "                intro = false;\n"
+ "                render();\n"
+ "            }\n"
+ "            else\n"
+ "                move(1, true); }, intro ? 2500 : Number(get('[data-gallery-interval]').value) * 1000); };\n"
+ "        const render = () => {\n"
+ "            const current = entries[gallery], photo = current.photos[index];\n"
+ "            get('[data-viewer-title]').textContent = current.title;\n"
+ "            get('[data-gallery-position]').textContent = `Gallery ${gallery + 1} of ${entries.length}`;\n"
+ "            const image = get('[data-viewer-image]');\n"
+ "            image.fetchPriority='high';image.loading='eager';if(image.getAttribute('src')!==photo.src)image.src = photo.src;\n"
+ "            image.alt = photo.alt;image.hidden=ended;\n"
+ "            get('[data-gallery-end]').hidden=!ended;\n"
+ "            get('[data-image-caption]').hidden=ended;\n"
+ "            get('[data-action=\"next\"]').disabled=ended;\n"
+ "            get('[data-image-counter]').textContent = `${index + 1} / ${current.photos.length}`;\n"
+ "            get('[data-image-caption]').textContent = photo.title && photo.title !== photo.alt ? `${photo.title} · ${photo.alt}` : photo.alt;\n"
+ "            get('[data-viewer-status]').textContent = ended?'You’ve reached the end of these galleries.':`${current.title}, image ${index + 1} of ${current.photos.length}`;\n"
+ "            const play = get('[data-action=\"play\"]');\n"
+ "            play.setAttribute('aria-label',playing ? 'Pause slideshow' : 'Play slideshow'); play.title=play.getAttribute('aria-label');\n"
+ "            play.setAttribute('aria-pressed', String(playing));play.disabled=ended;\n"
+ "            const overlay = get('[data-action=\"start\"]');\n"
+ "            overlay.hidden = !intro;\n"
+ "            get('[data-intro-title]').textContent = current.title;\n"
+ "            const strip = get('[data-gallery-thumbnails]'), restoreThumbFocus = strip.contains(document.activeElement);\n"
+ "            const buildStrip=thumbnailGallery!==gallery;if(buildStrip){thumbnailLoader?.dispose();strip.replaceChildren();thumbnailGallery=gallery;\n"
+ "            current.photos.forEach((p, i) => { const button = document.createElement('button'), thumb = document.createElement('img'); button.type = 'button'; button.setAttribute('aria-label', `Image ${i + 1}: ${p.alt}`); button.setAttribute('aria-pressed', String(i === index)); thumb.dataset.thumbnailSrc=p.thumbnail; thumb.alt = ''; thumb.loading = 'lazy'; button.append(thumb); button.addEventListener('click', () => { index = i; intro = false; ended=false; render(); }); strip.append(button); });\n"
+ "            if(gallery<entries.length-1){const upcoming=entries[gallery+1],tile=document.createElement('button'),cover=document.createElement('img'),label=document.createElement('span');tile.type='button';tile.className='website-gallery-next-tile';tile.dataset.action='next-gallery';tile.setAttribute('aria-label',`Next gallery: ${upcoming.title}`);cover.dataset.thumbnailSrc=upcoming.photos[0].thumbnail;cover.alt='';label.textContent=`Next gallery · ${upcoming.title} →`;tile.append(cover,label);strip.append(tile);}\n"
+ "            }else current.photos.forEach((_,i)=>strip.children[i].setAttribute('aria-pressed',String(i===index)));\n"
+ "            get('[data-intro-cover]').removeAttribute('src');get('[data-intro-count]').textContent=`${current.photos.length} photos`;\n"
+ "            const active = strip.children[index];\n"
+ "            if (restoreThumbFocus)\n"
+ "                active.focus({ preventScroll: true });\n"
+ "            strip.scrollTo?.({ left: active.offsetLeft - strip.clientWidth / 2 + active.clientWidth / 2, behavior: reduced ? 'instant' : 'smooth' });\n"
+ "            const section = get('[data-purchase-section]');\n"
+ "            section.hidden = !current.linkGroups?.children.length && !photo.downloadAssetId && !photo.originalAssetId;\n"
+ "            if(linksGallery!==gallery){section.replaceChildren(...Array.from(current.linkGroups?.children??[],node=>node.cloneNode(true)));linksGallery=gallery;}\n"
+ "            let download=section.querySelector('[data-current-photo-download]');if(!download){download=document.createElement('button');download.type='button';download.dataset.currentPhotoDownload='true';download.textContent='Download original';section.append(download);}download.hidden=!photo.downloadAssetId||intro||ended;if(photo.downloadAssetId)download.dataset.galleryDownload=photo.downloadAssetId;\n"
+ "            let original=section.querySelector('[data-current-photo-original]');if(!original){original=document.createElement('button');original.type='button';original.dataset.currentPhotoOriginal='true';original.textContent='View original';section.append(original);}original.hidden=!photo.originalAssetId||intro||ended;if(photo.originalAssetId)original.dataset.galleryOriginal=photo.originalAssetId;\n"
+ "            const previous = get('[data-action=\"previous-gallery\"]'), next = get('[data-action=\"next-gallery\"]');\n"
+ "            previous.hidden = next.hidden = entries.length < 2;\n"
+ "            previous.textContent = '‹'; previous.setAttribute('aria-label', `Previous gallery: ${entries[(gallery - 1 + entries.length) % entries.length].title}`);\n"
+ "            next.textContent = gallery===entries.length-1?'End of galleries':`Next: ${entries[gallery+1].title} ›`;next.disabled=ended;\n"
+ "            if(buildStrip)thumbnailLoader=createThumbnailLoader(image,strip,Array.from(strip.querySelectorAll('img[data-thumbnail-src]')),index,()=>dialog.open&&thumbnailGallery===gallery,()=>{if(intro)get('[data-intro-cover]').src=entries[gallery].photos[0].thumbnail;schedule();});else thumbnailLoader.focus(index);\n"
+ "            schedule();\n"
+ "        };\n"
+ "        const finish=()=>{playing=false;intro=false;ended=true;render();get('[data-action=\"restart\"]').focus({preventScroll:true});};\n"
+ "        const restart=()=>{gallery=0;index=0;playing=false;intro=false;ended=false;render();dialog.focus();};\n"
+ "        const switchGallery = (direction, last = false, automatic = false) => { if(direction>0&&gallery===entries.length-1){finish();return;}ended=false;gallery = (gallery + direction + entries.length) % entries.length; index = last ? entries[gallery].photos.length - 1 : 0; intro = automatic && playing && entries.length > 1; render(); };\n"
+ "        const move = (direction, automatic = false) => { if(ended){if(direction<0){ended=false;render();}return;} if (intro) {\n"
+ "            intro = false;\n"
+ "            render();\n"
+ "            return;\n"
+ "        } const next = index + direction; if (next < 0)\n"
+ "            switchGallery(-1, true);\n"
+ "        else if (next >= entries[gallery].photos.length)\n"
+ "            switchGallery(1, false, automatic);\n"
+ "        else {\n"
+ "            index = next;\n"
+ "            render();\n"
+ "        } };\n"
+ "        const toggle = () => { if(ended)return;playing = !playing; intro = false; render(); };\n"
+ "        const surface=get('[data-gallery-surface]'),fullButton=get('[data-action=\"fullscreen\"]');\n"
+ "        let focused=false,nativeFullscreen=false,fullscreenGeneration=0;\n"
+ "        const setFocused=value=>{focused=value;surface.classList.toggle('is-fullscreen',value);fullButton.setAttribute('aria-label',value?'Exit full screen':'Full screen');fullButton.title=fullButton.getAttribute('aria-label');fullButton.setAttribute('aria-pressed',String(value));if(value)dialog.scrollTop=0;else get('[data-viewer-status]').textContent='';};\n"
+ "        const leaveFullscreen=()=>{fullscreenGeneration++;setFocused(false);if(document.fullscreenElement===surface)void document.exitFullscreen().catch(()=>{});};\n"
+ "        const fullscreen=()=>{\n"
+ "            if(focused){leaveFullscreen();return;}\n"
+ "            setFocused(true);const generation=++fullscreenGeneration;\n"
+ "            const fallback=()=>{if(focused&&generation===fullscreenGeneration)get('[data-viewer-status]').textContent='Using full-window view. Press Escape or Exit full screen to return.';};\n"
+ "            if(!surface.requestFullscreen||document.fullscreenEnabled===false){fallback();return;}\n"
+ "            try{Promise.resolve(surface.requestFullscreen()).then(()=>{if(!focused||!dialog.open||generation!==fullscreenGeneration){if(document.fullscreenElement===surface)void document.exitFullscreen().catch(()=>{});}}).catch(fallback);}catch{fallback();}\n"
+ "        };\n"
+ "        document.addEventListener('fullscreenchange',()=>{const active=document.fullscreenElement===surface;if(nativeFullscreen&&!active)setFocused(false);nativeFullscreen=active;});\n"
+ "        const helpButton=get('[data-action=\"help\"]'),helpPanel=get('[data-gallery-help]');helpPanel.id=`website-gallery-help-${rootIndex}`;helpButton.setAttribute('aria-controls',helpPanel.id);\n"
+ "        const setHelp=(open,restoreFocus=false)=>{helpPanel.hidden=!open;helpButton.setAttribute('aria-expanded',String(open));if(restoreFocus)helpButton.focus();};\n"
+ "        dialog.addEventListener('keydown',event=>{if(!helpPanel.hidden&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();setHelp(false,true);}},true);\n"
+ "        dialog.addEventListener('click',event=>{if(!event.target.closest?.('.website-gallery-help-control'))setHelp(false);});\n"
+ "        const cleanup = () => { setHelp(false);leaveFullscreen();stop(); playing = false; intro = false; ended=false;document.body.style.overflow = overflow; opener?.focus(); };\n"
+ "        const fitLinkPopup=panel=>{panel.style.marginLeft='0px';const rect=panel.getBoundingClientRect(),container=panel.closest('dialog'),right=container?container.getBoundingClientRect().left+container.clientWidth:document.documentElement.clientWidth;panel.style.marginLeft=`${rect.left<12?12-rect.left:Math.min(0,right-rect.right-12)}px`;};\n"
+ "        for(const type of ['pointerover','focusin'])root.addEventListener(type,event=>{const link=event.target.closest?.('.website-gallery-platform-link');if(link)fitLinkPopup(link.querySelector('.website-gallery-link-tooltip'));});\n"
+ "        root.addEventListener('keydown',event=>{if(event.key!=='Escape')return;const menu=event.target.closest?.('.website-gallery-platform-menu[open]');if(menu){event.preventDefault();event.stopPropagation();menu.open=false;menu.querySelector('summary').focus();}},true);\n"
+ "        document.addEventListener('click',event=>{for(const menu of root.querySelectorAll('.website-gallery-platform-menu[open]'))if(!menu.contains(event.target))menu.open=false;});\n"
+ "        root.addEventListener('toggle',event=>{const menu=event.target;if(!menu.matches?.('.website-gallery-platform-menu[open]'))return;for(const other of root.querySelectorAll('.website-gallery-platform-menu[open]'))if(other!==menu)other.open=false;fitLinkPopup(menu.querySelector('.website-gallery-link-options'));},true);\n"
+ "        root.addEventListener('click',event=>{const button=event.target instanceof Element?event.target.closest('[data-gallery-original]'):undefined;if(button){event.preventDefault();root.dispatchEvent(new CustomEvent('website-gallery-original',{bubbles:true,detail:{assetId:button.dataset.galleryOriginal,button}}));}});\n"
+ "        root.addEventListener('click',event=>{const button=event.target instanceof Element?event.target.closest('[data-gallery-download]'):undefined;if(button){event.preventDefault();root.dispatchEvent(new CustomEvent('website-gallery-download',{bubbles:true,detail:{assetId:button.dataset.galleryDownload,button}}));}});\n"
+ "        root.addEventListener('click', event => { const target = event.target instanceof Element ? event.target.closest('[data-gallery-open]') : null; if (!target || event instanceof MouseEvent && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey))\n"
+ "            return; const at = entries.findIndex(g => g.id === target.dataset.galleryOpen); if (at < 0)\n"
+ "            return; event.preventDefault(); gallery = at; index = Math.max(0, Math.min(Number(target.dataset.photoIndex) || 0, entries[at].photos.length - 1)); playing = false; intro = false; ended=false;opener = target; overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; dialog.showModal(); render(); dialog.focus(); });\n"
+ "        dialog.addEventListener('click', event => { const action = event.target instanceof Element ? event.target.closest('[data-action]')?.dataset.action : undefined; switch (action) {\n"
+ "            case 'close':\n"
+ "                leaveFullscreen();\n"
+ "                dialog.close();\n"
+ "                break;\n"
+ "            case 'previous':\n"
+ "                move(-1);\n"
+ "                break;\n"
+ "            case 'next':\n"
+ "                move(1);\n"
+ "                break;\n"
+ "            case 'play':\n"
+ "                toggle();\n"
+ "                break;\n"
+ "            case 'help':\n"
+ "                setHelp(helpPanel.hidden);\n"
+ "                break;\n"
+ "            case 'close-help':\n"
+ "                setHelp(false,true);\n"
+ "                break;\n"
+ "            case 'fullscreen':\n"
+ "                fullscreen();\n"
+ "                break;\n"
+ "            case 'previous-gallery':\n"
+ "                switchGallery(-1);\n"
+ "                break;\n"
+ "            case 'next-gallery':\n"
+ "                switchGallery(1);\n"
+ "                break;\n"
+ "            case 'restart':\n"
+ "                restart();\n"
+ "                break;\n"
+ "            case 'start':\n"
+ "                intro = false;\n"
+ "                render();\n"
+ "                break;\n"
+ "        } });\n"
+ "        dialog.addEventListener('close', cleanup);\n"
+ "        dialog.addEventListener('cancel', event => { if(!helpPanel.hidden){event.preventDefault();setHelp(false,true);}else if(focused){event.preventDefault();leaveFullscreen();} });\n"
+ "        dialog.addEventListener('keydown', event => { if (event.target.closest('input,select,textarea,a,summary,[data-gallery-help]'))\n"
+ "            return; const key = event.key; let handled = true; if (key === 'ArrowLeft')\n"
+ "            move(-1);\n"
+ "        else if (key === 'ArrowRight')\n"
+ "            move(1);\n"
+ "        else if (key === 'PageUp' || key === 'ArrowUp')\n"
+ "            switchGallery(-1);\n"
+ "        else if (key === 'PageDown' || key === 'ArrowDown')\n"
+ "            switchGallery(1);\n"
+ "        else if (key === 'Home') {\n"
+ "            ended=false;index = 0;\n"
+ "            intro = false;\n"
+ "            render();\n"
+ "        }\n"
+ "        else if (key === 'End') {\n"
+ "            ended=false;index = entries[gallery].photos.length - 1;\n"
+ "            intro = false;\n"
+ "            render();\n"
+ "        }\n"
+ "        else if ((key === ' ' || key === 'k') && event.target === dialog)\n"
+ "            toggle();\n"
+ "        else if (key.toLowerCase() === 'f')\n"
+ "            fullscreen();\n"
+ "        else\n"
+ "            handled = false; if (handled)\n"
+ "            event.preventDefault(); });\n"
+ "        const stage = get('[data-gallery-stage]');\n"
+ "        stage.addEventListener('click',event=>{if(event.target.closest('button'))return;const rect=stage.getBoundingClientRect();move(event.clientX-rect.left<rect.width*.35?-1:1);});\n"
+ "        stage.addEventListener('wheel', event => { const wheel = event, delta = Math.abs(wheel.deltaY) >= Math.abs(wheel.deltaX) ? wheel.deltaY : wheel.deltaX; if (wheel.ctrlKey || Math.abs(delta) < 8)\n"
+ "            return; wheel.preventDefault(); if (Date.now() - lastWheel < 450)\n"
+ "            return; lastWheel = Date.now(); move(delta > 0 ? 1 : -1); }, { passive: false });\n"
+ "        stage.addEventListener('pointerdown', event => { const p = event; if (p.pointerType === 'touch')\n"
+ "            pointer = { x: p.clientX, y: p.clientY }; });\n"
+ "        stage.addEventListener('pointerup', event => { const p = event; if (pointer) {\n"
+ "            const dx = p.clientX - pointer.x, dy = p.clientY - pointer.y;\n"
+ "            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5)\n"
+ "                move(dx < 0 ? 1 : -1);\n"
+ "            pointer = undefined;\n"
+ "        } });\n"
+ "        stage.addEventListener('pointercancel', () => { pointer = undefined; });\n"
+ "        get('[data-gallery-interval]').addEventListener('change', schedule);\n"
+ "        fullButton.setAttribute('aria-pressed','false');\n"
+ "        get('[data-viewer-image]').addEventListener('error', () => { get('[data-viewer-status]').textContent = 'This image could not be loaded. Try another image or reopen the gallery.'; });\n"
+ "        document.addEventListener('visibilitychange', () => { if (document.hidden && playing) {\n"
+ "            playing = false;\n"
+ "            intro = false;\n"
+ "            render();\n"
+ "        } });\n"
+ "    }\n"
+ "})();";
export const websiteGalleryCss=`
.template-standard .page-content:has(.website-gallery-group){max-width:none}
.website-gallery-group{padding-block:1rem}
.website-gallery-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:28px 16px}
.website-gallery-teaser{min-width:0;text-align:left;box-sizing:border-box;padding:12px;border:1px solid color-mix(in srgb,var(--color-text) 18%,transparent);border-radius:14px}
.website-gallery-tile{display:flex;flex-direction:column;gap:12px;color:var(--color-text);text-decoration:none}
.website-gallery-cover{position:relative;display:block;width:100%;aspect-ratio:4/5;border-radius:12px;overflow:hidden;background:color-mix(in srgb,var(--color-muted) 15%,var(--color-canvas))}
.website-gallery-teaser .website-gallery-cover{aspect-ratio:1/1}
.website-gallery-cover img{display:block;width:100%;height:100%;object-fit:cover;transition:transform .5s ease}
.website-gallery-tile:hover img,.website-gallery-tile:focus-visible img{transform:scale(1.04)}
.website-gallery-tile:focus-visible{outline:3px solid var(--color-focus);outline-offset:4px;border-radius:12px}
.website-gallery-count,.website-gallery-view{position:absolute;display:flex;align-items:center;gap:6px;border-radius:999px;font-family:inherit;line-height:1.3;font-weight:700}
.website-gallery-count{top:10px;right:10px;padding:5px 9px;background:#0e0f12b8;color:#fff;font-size:12px}
.website-gallery-view{left:10px;bottom:10px;padding:7px 12px;background:#fff;color:#16181d;font-size:13px}
.website-gallery-tile-title{padding:0 2px;font-size:18px;font-weight:800;letter-spacing:-.01em;line-height:1.35}
.website-gallery-teaser p{margin:2px 2px 0;font-size:14px;color:var(--color-muted)}
.website-gallery-teaser .website-gallery-availability{margin-top:6px;font-size:13px}
.website-gallery-link-group{--gallery-link-color:var(--color-action);display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;min-width:0}
.website-gallery-link-group[data-link-kind=additional]{--gallery-link-color:var(--color-muted)}
.website-gallery-teaser>.website-gallery-link-group{margin-top:12px}
.website-gallery-group .website-gallery-link-heading{margin:0;font:inherit;font-size:14px;line-height:1.5;color:var(--gallery-link-color);letter-spacing:normal;text-transform:none}
.website-gallery-link-icons{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.website-gallery-group .website-gallery-platform-link,.website-gallery-group .website-gallery-platform-menu>summary{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:5px;box-sizing:border-box;min-width:44px;min-height:44px;padding:10px;color:var(--gallery-link-color);background:transparent;border:1px solid currentColor;border-radius:10px;cursor:pointer;text-decoration:none;list-style:none;line-height:1}
.website-gallery-platform-menu{position:relative;margin:0;padding:0;border:0}
.website-gallery-platform-menu>summary::-webkit-details-marker{display:none}
.website-gallery-link-chevron{transition:transform .15s}.website-gallery-platform-menu[open] .website-gallery-link-chevron{transform:rotate(180deg)}
.website-gallery-platform-link>svg,.website-gallery-platform-menu>summary>svg{flex:none}
.website-gallery-platform-link:hover,.website-gallery-platform-menu>summary:hover{background:color-mix(in srgb,var(--gallery-link-color) 12%,transparent)}
.website-gallery-platform-link:focus-visible,.website-gallery-platform-menu>summary:focus-visible,.website-gallery-link-options>a:focus-visible{outline:3px solid var(--color-focus);outline-offset:3px}
.website-gallery-link-tooltip{position:absolute;z-index:25;bottom:calc(100% + 6px);left:0;width:max-content;max-width:min(240px,70vw);padding:7px 10px;border-radius:6px;background:var(--color-surface,var(--color-canvas));color:var(--color-text);border:1px solid var(--color-border);font-family:inherit;font-weight:400;font-size:13px;line-height:1.4;white-space:normal;overflow-wrap:anywhere;pointer-events:none;opacity:0;visibility:hidden;text-transform:none;letter-spacing:normal}
.website-gallery-platform-link:hover .website-gallery-link-tooltip,.website-gallery-platform-link:focus-visible .website-gallery-link-tooltip{opacity:1;visibility:visible}
.website-gallery-link-options{position:absolute;z-index:24;left:0;top:calc(100% + 6px);box-sizing:border-box;width:max-content;min-width:180px;max-width:min(280px,calc(100vw - 24px));padding:6px;background:var(--color-surface,var(--color-canvas));color:var(--color-text);border:1px solid var(--color-border);border-radius:10px;box-shadow:0 8px 28px #0005}
.website-gallery-group .website-gallery-link-options>a{display:block;padding:12px;min-height:44px;box-sizing:border-box;border-radius:5px;font:inherit;font-size:14px;line-height:1.4;color:inherit;text-decoration:none;overflow-wrap:anywhere;letter-spacing:normal;text-transform:none}
.website-gallery-link-options>a:hover{background:color-mix(in srgb,var(--gallery-link-color) 15%,transparent)}
.website-gallery-viewer .website-gallery-link-group{--gallery-link-color:color-mix(in srgb,var(--color-action) 50%,var(--viewer-text))}
.website-gallery-viewer .website-gallery-link-group[data-link-kind=additional]{--gallery-link-color:var(--viewer-muted)}
.website-gallery-viewer .website-gallery-link-options,.website-gallery-viewer .website-gallery-link-tooltip{background:var(--viewer-panel);color:var(--viewer-text);border-color:#4a4f5a}
.website-gallery-downloads{display:flex;flex-wrap:wrap;gap:12px}.website-gallery-purchase>[data-current-photo-download]{margin:0}
.website-gallery-static-purchase{display:flex;flex-wrap:wrap;gap:12px 24px;margin-top:20px}
.website-gallery-empty-cover{display:grid;place-items:center;height:100%;color:var(--color-muted)}
.website-gallery-viewer{--viewer-bg:#0e0f12;--viewer-panel:#1b1d22;--viewer-border:#23262d;--viewer-text:#f3f4f6;--viewer-muted:#9aa0ab;box-sizing:border-box;width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;margin:0;padding:0;border:0;background:var(--viewer-bg);color:var(--viewer-text);font:inherit;overflow:auto;text-align:left}
.website-gallery-viewer::backdrop{background:#0e0f12}
.website-gallery-viewer [hidden]{display:none!important}
.website-gallery-viewer-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:12px 24px;border-bottom:1px solid var(--viewer-border)}
.website-gallery-heading,.website-gallery-controls{display:flex;align-items:center;gap:8px;min-width:0}
.website-gallery-heading{flex:1}.website-gallery-heading>div{min-width:0;padding-inline:2px}
.website-gallery-viewer .website-gallery-heading h2{margin:0;font-family:inherit;font-size:18px;font-weight:800;line-height:1.3}
.website-gallery-heading p{margin:2px 0 0;color:var(--viewer-muted);font-size:12px;font-variant-numeric:tabular-nums}
.website-gallery-viewer button,.website-gallery-viewer select{font:inherit;font-size:14px;font-weight:700;line-height:1.3;color:var(--viewer-text);background:var(--viewer-panel);border:0;border-radius:10px;min-height:44px;padding:0 16px;cursor:pointer}
.website-gallery-controls{gap:16px;margin-left:auto}
.website-gallery-controls [data-gallery-interval]{margin-left:-8px}
.website-gallery-viewer .website-gallery-icon-button{display:inline-flex;align-items:center;justify-content:center;flex:0 0 44px;width:44px;height:44px;padding:0}
.website-gallery-icon-button svg{flex:none}
.website-gallery-controls [data-action=play][aria-pressed=false] [data-icon=pause],.website-gallery-controls [data-action=play][aria-pressed=true] [data-icon=play],.website-gallery-controls [data-action=fullscreen][aria-pressed=false] [data-icon=contract],.website-gallery-controls [data-action=fullscreen][aria-pressed=true] [data-icon=expand]{display:none}
.website-gallery-viewer [data-action=close]{border-radius:50%}
.website-gallery-help-control{position:relative;flex:none}
.website-gallery-help-panel{position:absolute;right:0;top:calc(100% + 12px);z-index:30;box-sizing:border-box;width:min(360px,calc(100vw - 108px));max-height:65dvh;overflow:auto;padding:20px;background:var(--viewer-panel);border:1px solid #4a4f5a;border-radius:12px;box-shadow:0 12px 40px #0008;color:var(--viewer-text);font-size:14px;line-height:1.5}
.website-gallery-help-panel h3{margin:0 0 12px;font:inherit;font-size:16px;font-weight:700;color:inherit}
.website-gallery-help-panel p{margin:0 0 16px;color:var(--viewer-muted);font:inherit}
.website-gallery-help-panel dl{display:grid;grid-template-columns:auto 1fr;gap:10px 16px;margin:0 0 16px}
.website-gallery-help-panel dt{font-weight:700}.website-gallery-help-panel dd{margin:0;color:var(--viewer-muted)}
.website-gallery-help-panel [data-action=close-help]{border:1px solid #4a4f5a}
.website-gallery-heading [data-action=previous-gallery]{width:44px;padding:0;flex-shrink:0;font-size:24px}
.website-gallery-heading [data-action=next-gallery]{margin-left:8px;max-width:35%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.website-gallery-viewer [data-action=play][aria-pressed=true]{background:var(--color-action);color:var(--color-canvas)}
.website-gallery-viewer button:focus-visible,.website-gallery-viewer select:focus-visible,.website-gallery-viewer a:focus-visible{outline:3px solid var(--color-focus);outline-offset:3px}
.website-gallery-progress{height:3px;background:var(--viewer-panel)}
.website-gallery-progress>span,.website-gallery-intro-progress>span{display:block;width:100%;height:100%;transform:scaleX(0);transform-origin:left;background:var(--color-action)}
.website-gallery-viewer .website-gallery-purchase{letter-spacing:normal;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px 28px;padding:10px 24px;background:#15171b;border-bottom:1px solid var(--viewer-border)}
.website-gallery-stage{position:relative;display:flex;align-items:center;justify-content:center;box-sizing:border-box;flex:1 1 0;min-height:120px;padding:6px 96px 2px;touch-action:pan-y pinch-zoom;cursor:e-resize}
.website-gallery-stage>img{display:block;width:auto;height:auto;max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;box-shadow:0 20px 60px #0008}
.website-gallery-stage .website-gallery-stage-prev,.website-gallery-stage .website-gallery-stage-next{position:absolute;top:50%;transform:translateY(-50%);width:52px;height:52px;min-height:0;padding:0;border:1px solid #ffffff2e;border-radius:50%;background:#ffffff1a;color:#fff;font-size:28px}
.website-gallery-stage-prev{left:24px}.website-gallery-stage-next{right:24px}
.website-gallery-caption-area{padding:0 24px 2px}
.website-gallery-viewer .website-gallery-caption{margin:0;font-size:12px;line-height:1.4;font-weight:600;max-width:none}
.website-gallery-thumbnails{position:relative;display:flex;gap:6px;overflow-x:auto;padding:2px 24px 8px}
.website-gallery-viewer .website-gallery-thumbnails button{box-sizing:border-box;flex:0 0 130px;width:130px;height:88px;min-height:0;margin:0;padding:0;border:1px solid transparent;border-radius:8px;overflow:hidden;opacity:.55;background:none}
.website-gallery-viewer .website-gallery-thumbnails button[aria-pressed=true]{opacity:1;border-color:var(--color-action)}
.website-gallery-thumbnails img{display:block;width:100%;height:100%;object-fit:cover}
.website-gallery-viewer .website-gallery-thumbnails .website-gallery-next-tile{display:flex;align-items:center;gap:12px;flex-basis:auto;width:auto;max-width:340px;margin-left:8px;padding-right:16px;border-color:#2a2d35;background:var(--viewer-panel);opacity:1;text-align:left}
.website-gallery-next-tile img{width:66px;flex-shrink:0}.website-gallery-next-tile span{font-size:14px}
.website-gallery-end-note{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:1rem;padding:1rem;margin-top:1rem;border:1px solid var(--color-border);border-radius:.75rem}.website-gallery-end-note p{margin:0}.website-gallery-end-note a{color:var(--color-action);padding:.65rem 1rem;border:1px solid var(--color-action);border-radius:.5rem;text-decoration:none;font-weight:700}
.website-gallery-stage .website-gallery-end{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;padding:1.5rem;text-align:center;background:var(--viewer-bg);cursor:default}.website-gallery-end h3{font-size:clamp(1.4rem,3vw,2.4rem);line-height:1.2;margin:0}.website-gallery-end p{margin:0;color:var(--viewer-muted)}.website-gallery-end [data-action=restart]{background:var(--color-action);color:var(--color-canvas);padding:.75rem 1.25rem}
.website-gallery-stage .website-gallery-intro{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:36px;padding:24px;background:var(--viewer-bg);border-radius:0;z-index:2;text-align:left}
.website-gallery-intro>img{width:min(30vw,280px);height:min(30vw,280px);object-fit:cover;border-radius:14px}
.website-gallery-intro>span{display:flex;flex-direction:column;gap:10px;width:min(40vw,300px)}
.website-gallery-intro strong{font-size:clamp(24px,4vw,52px);line-height:1.05;overflow-wrap:anywhere}
.website-gallery-intro small{font-size:13px;color:var(--viewer-muted)}
.website-gallery-intro-progress{display:block;height:4px;background:var(--viewer-border);margin-top:12px}
.website-gallery-static-purchase{margin-block:1.5rem}.website-gallery-static-purchase a{margin:.35rem .5rem .35rem 0}
.website-gallery-announcement{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.website-gallery-surface{display:flex;flex-direction:column;height:100dvh;min-height:100%;background:var(--viewer-bg)}
.website-gallery-surface>:not(.website-gallery-stage){flex-shrink:0}
.website-gallery-surface.is-fullscreen{display:flex;flex-direction:column;width:100%;height:100dvh;overflow:hidden;background:var(--viewer-bg);color:var(--viewer-text)}
.website-gallery-surface.is-fullscreen .website-gallery-stage{flex:1;min-height:0;height:auto;padding:8px 80px}
.website-gallery-surface.is-fullscreen .website-gallery-viewer-header{flex-shrink:0}
.website-gallery-surface.is-fullscreen :is(.website-gallery-purchase,.website-gallery-caption-area,.website-gallery-thumbnails){display:none}
@media(max-width:1000px){.website-gallery-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:480px){.website-gallery-tiles{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.website-gallery-viewer-header{padding:12px;gap:10px}.website-gallery-heading{flex-basis:100%}.website-gallery-controls{width:100%;justify-content:flex-end;gap:16px}.website-gallery-controls select{padding-inline:10px}.website-gallery-stage{padding:4px 12px 2px}.website-gallery-stage .website-gallery-stage-prev,.website-gallery-stage .website-gallery-stage-next{width:40px;height:40px;background:#0e0f12b8}.website-gallery-stage-prev{left:8px}.website-gallery-stage-next{right:8px}.website-gallery-purchase{padding:12px}.website-gallery-caption-area{padding:0 12px 2px}.website-gallery-thumbnails{padding:2px 12px 8px}.website-gallery-stage .website-gallery-intro{gap:18px}.website-gallery-surface.is-fullscreen .website-gallery-stage{height:auto;padding:6px 12px}}
@media(prefers-reduced-motion:reduce){.website-gallery-cover img{transition:none}.website-gallery-tile:hover img{transform:none}}
`;
