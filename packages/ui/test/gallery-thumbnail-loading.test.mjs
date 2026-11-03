import test from 'node:test';
import assert from 'node:assert/strict';
import {createGalleryThumbnailLoader,renderWebsiteGalleryGroup} from '../dist/index.js';
function fixture(count=24,index=0){
 const requests=[];
 class Image extends EventTarget{
  complete=false;naturalWidth=0;currentSrc='';dataset={};_src='';
  set src(value){this._src=value;this.complete=false;requests.push(value);}get src(){return this._src;}
  getAttribute(name){return name==='src'?this._src:null;}
  finish(success=true){this.complete=true;this.naturalWidth=success?100:0;this.currentSrc=this.src;this.dispatchEvent(new Event(success?'load':'error'));}
 }
 const primary=new Image();primary._src='focused-image';const strip=new EventTarget();strip.scrollLeft=Math.floor(index/6)*600;strip.clientWidth=600;
 const images=Array.from({length:count},(_,i)=>{const image=new Image();image.dataset.thumbnailSrc='thumbnail-'+i;image.parentElement={offsetLeft:i*100,offsetWidth:100};return image;});
 let active=true;const loader=()=>createGalleryThumbnailLoader(primary,strip,images,index,()=>active);
 return {requests,primary,strip,images,loader,set active(value){active=value;}};
}
test('the focus image completes before thumbnails begin, with six low-priority requests per batch',()=>{
 const f=fixture(),loader=f.loader();assert.deepEqual(f.requests,[]);
 f.primary.finish();assert.deepEqual(f.requests,Array.from({length:6},(_,i)=>'thumbnail-'+i));assert.ok(f.images.slice(0,6).every(i=>i.fetchPriority==='low'));
 f.strip.scrollLeft=600;f.strip.dispatchEvent(new Event('scroll'));assert.equal(f.requests.length,6);
 f.images.slice(0,5).forEach(i=>i.finish());assert.equal(f.requests.length,6);
 f.images[5].finish();assert.deepEqual(f.requests.slice(6),Array.from({length:6},(_,i)=>'thumbnail-'+(i+6)));
 f.images.slice(6,12).forEach(i=>i.finish());assert.equal(f.requests.length,12);loader.dispose();
});
test('opening a later image starts with the six thumbnails surrounding that image',()=>{
 const f=fixture(30,20),loader=f.loader();f.primary.finish();assert.deepEqual(f.requests,Array.from({length:6},(_,i)=>'thumbnail-'+(i+18)));loader.dispose();
});
test('cached focus images release their first batch without waiting for a new load event',()=>{
 const f=fixture();f.primary.complete=true;f.primary.naturalWidth=100;f.primary.currentSrc=f.primary.src;const loader=f.loader();assert.equal(f.requests.length,6);loader.dispose();
});
test('old image events and disposed viewers cannot start thumbnail requests',()=>{
 const f=fixture();f.primary.complete=true;f.primary.naturalWidth=100;f.primary.currentSrc='previous-image';const loader=f.loader();assert.equal(f.requests.length,0);
 loader.dispose();f.primary.finish();f.strip.dispatchEvent(new Event('scroll'));assert.equal(f.requests.length,0);
 const g=fixture(),other=g.loader();g.active=false;g.primary.finish();assert.equal(g.requests.length,0);other.dispose();
});
test('a failed focus image does not start thumbnails, while failed thumbnails release the next queued batch',()=>{
 const f=fixture(),loader=f.loader();f.primary.finish(false);assert.equal(f.requests.length,0);f.primary.finish();f.strip.scrollLeft=600;f.strip.dispatchEvent(new Event('scroll'));f.images.slice(0,6).forEach(i=>i.finish(false));assert.equal(f.requests.length,12);loader.dispose();
});
test('hidden gallery data does not put full images or thumbnails on the browser request queue',()=>{
 const html=renderWebsiteGalleryGroup([{id:'test',title:'Gallery',href:'/gallery',photos:[{src:'/full-image',thumbnail:'/small-thumbnail',alt:'Image'}]}]);
 const metadata=html.slice(html.indexOf('<div hidden data-gallery-data>'),html.indexOf('<dialog'));
 assert.match(metadata,/data-gallery-full data-src="\/full-image"/);assert.match(metadata,/data-gallery-thumb data-src="\/small-thumbnail"/);assert.doesNotMatch(metadata,/\ssrc=/);
});

test('moving the focus preserves the thumbnail cache and reuses the strip loader',()=>{
 const f=fixture(),loader=f.loader();f.primary.finish();f.images.slice(0,6).forEach(i=>i.finish());assert.equal(f.requests.length,6);
 f.primary._src='second-focus';f.primary.complete=false;f.primary.currentSrc='focused-image';loader.focus(1);assert.equal(f.requests.length,6);f.primary.finish();assert.equal(f.requests.length,6);loader.dispose();
});
