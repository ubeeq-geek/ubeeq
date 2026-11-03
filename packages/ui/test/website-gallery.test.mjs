import test from 'node:test';
import assert from 'node:assert/strict';
import {renderWebsiteGalleryGroup,websiteGalleryViewerScript,websiteGalleryCss,renderWebsiteGalleryLinks} from '../dist/index.js';
import {websiteRoutes} from '@ubeeq/core';
const photo={src:'/portfolio/assets/full.jpg',thumbnail:'/portfolio/assets/thumb.jpg',alt:'Mountain light',workHref:'/portfolio/galleries/light/'};
const entries=[{id:'coast',title:'Coast & sky',href:'/portfolio/galleries/coast/',photos:[photo,photo]},{id:'peaks',title:'Peaks',href:'/portfolio/galleries/peaks/',photos:[photo],purchaseText:'Available as a print',purchaseLinks:[{label:'Buy the collection',url:'https://shop.example/collection',priceText:'$12'}]}];
test('gallery covers show counts and native page links, with optional purchase information',()=>{
 const html=renderWebsiteGalleryGroup(entries);
 assert.match(html,/data-gallery-open="coast"/);assert.match(html,/Coast &amp; sky/);assert.match(html,/2 images/);assert.match(html,/href="\/portfolio\/galleries\/coast\/"/);
 assert.match(html,/Available as a print/);assert.match(html,/Buy the collection · \$12/);assert.match(html,/data-gallery-dialog/);assert.match(html,/Play slideshow/);assert.match(html,/data-gallery-thumbnails/);
 const plain=renderWebsiteGalleryGroup([{...entries[0],photos:[]}]);assert.doesNotMatch(plain,/data-gallery-purchase-text|data-gallery-purchase href/);assert.match(plain,/No preview image/);
});
test('work gallery tiles open the selected image and preserve their Work-page fallback',()=>{
 const html=renderWebsiteGalleryGroup(entries,'coast');assert.match(html,/data-photo-index="1"/);assert.match(html,/href="\/portfolio\/galleries\/light\/"/);assert.match(html,/data-gallery-full data-src="\/portfolio\/assets\/full.jpg"/);
});
test('purchase labels are escaped and unsafe URLs are rejected',()=>{
 const html=renderWebsiteGalleryGroup([{...entries[1],purchaseText:'<script>bad()</script>'}]);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
 for(const url of ['javascript:alert(1)','data:text/html,bad','https://user:secret@example.com/'])assert.throws(()=>renderWebsiteGalleryGroup([{...entries[1],purchaseLinks:[{label:'Buy',url}]}]));
 assert.doesNotThrow(()=>new Function(websiteGalleryViewerScript));assert.match(websiteGalleryCss,/prefers-reduced-motion/);assert.match(websiteGalleryCss,/object-fit:contain/);
});
test('gallery settings validate optional purchase fields without requiring them',()=>{
 const site={id:'site',workspaceId:'creator',creatorIdentityId:'creator',revision:1,title:'Site',locale:'en',homePageId:'home',theme:{id:'neutral',version:'1',settings:{}},galleryDefault:{destination:{mode:'local'}},mediaMode:'bundled',basePath:'/',pages:[{id:'home',websiteId:'site',workspaceId:'creator',revision:1,documentId:'doc',kind:'home',title:'Home',slug:'',state:'ready',order:0}],galleryPublicationIds:[],redirects:[],namedGalleries:[{id:'one',title:'One',slug:'one',kind:'works',access:'free',publicationIds:[],purchaseLinks:[{label:'Print',url:'https://shop.example/print',priceText:'$12'}]}]};
 assert.doesNotThrow(()=>websiteRoutes(site));site.namedGalleries[0].purchaseLinks[0].url='javascript:bad()';assert.throws(()=>websiteRoutes(site));delete site.namedGalleries[0].purchaseLinks;assert.doesNotThrow(()=>websiteRoutes(site));
});

test('large teaser and gallery tiles use the published rendition while viewer thumbnails stay small',()=>{
 for(const selected of [undefined,'coast']){
  const html=renderWebsiteGalleryGroup(entries,selected),tiles=html.split('<div hidden data-gallery-data>')[0];
  assert.match(tiles,/src="\/portfolio\/assets\/full.jpg"/);
  assert.doesNotMatch(tiles,/src="\/portfolio\/assets\/thumb.jpg"/);
  assert.match(html,/data-gallery-thumb data-src="\/portfolio\/assets\/thumb.jpg"/);
 }
});

test('teasers expose platform purchase links outside the viewer trigger',()=>{
 const html=renderWebsiteGalleryGroup(entries),visible=html.split('<div hidden data-gallery-data>')[0];
 assert.match(visible,/class="website-gallery-platform-link" href="https:\/\/shop.example\/collection"/);
 assert.match(visible,/aria-label="shop.example: Buy the collection · \$12"/);
 const empty=renderWebsiteGalleryGroup([entries[0]]).split('<div hidden data-gallery-data>')[0];assert.doesNotMatch(empty,/website-gallery-platform-link/);
 const linksOnly=renderWebsiteGalleryGroup([{...entries[1],purchaseText:undefined}]).split('<div hidden data-gallery-data>')[0];assert.match(linksOnly,/Want more\?/);
});

test('link groups default their headings and hide headings without links',()=>{
 assert.equal(renderWebsiteGalleryLinks({purchaseText:'Want more?',externalLinksText:'Custom heading'}),'');
 const html=renderWebsiteGalleryLinks({purchaseLinks:[{label:'Prints',url:'https://etsy.com/shop/prints'}],externalLinks:[{label:'Portfolio',url:'https://www.deviantart.com/artist/gallery'}]});
 assert.match(html,/Want more\?/);assert.match(html,/Also available on:/);
 assert.match(html,/aria-label="Etsy: Prints"/);assert.match(html,/aria-label="DeviantArt: Portfolio"/);
 assert.doesNotMatch(html,/<details/);assert.equal((html.match(/<svg /g)||[]).length,2);
 assert.match(html,/class="website-gallery-link-tooltip">Portfolio<\/span>/);
});

test('multiple URLs on one platform use one icon and labelled disclosure links',()=>{
 const html=renderWebsiteGalleryLinks({purchaseLinks:[{label:'Premium collection',url:'https://www.deviantart.com/artist/gallery/1',priceText:'$12'},{label:'Subscription',url:'https://deviantart.com/artist/subscriptions'},{label:'Print',url:'https://artist.etsy.com/print'}]});
 assert.equal((html.match(/<details /g)||[]).length,1);
 assert.match(html,/aria-label="DeviantArt · 2 links"/);
 assert.match(html,/>Premium collection · \$12<\/a>/);assert.match(html,/>Subscription<\/a>/);
 assert.equal((html.match(/<a /g)||[]).length,3);
 assert.match(html,/aria-label="Etsy: Print"/);
});

test('platforms come from URL hostnames and never trust labels or lookalike domains',()=>{
 const html=renderWebsiteGalleryLinks({externalLinks:[{label:'DeviantArt',url:'https://deviantart.com.evil.example/gallery'},{label:'Custom label',url:'https://deviantart.com/artist'}]});
 assert.match(html,/aria-label="deviantart.com.evil.example: DeviantArt"/);
 assert.match(html,/aria-label="DeviantArt: Custom label"/);
 assert.doesNotMatch(html,/<details/);
 for(const url of ['javascript:alert(1)','data:text/html,bad','https://user:secret@example.com/'])assert.throws(()=>renderWebsiteGalleryLinks({externalLinks:[{label:'Other',url}]}));
 const escaped=renderWebsiteGalleryLinks({externalLinksText:'<img src=x>',externalLinks:[{label:'<script>',url:'https://example.com/'}]});
 assert.doesNotMatch(escaped,/<img|<script>/);assert.match(escaped,/&lt;script&gt;/);
});

test('the selected gallery and viewer data retain both link groups',()=>{
 const gallery={...entries[0],purchaseLinks:[{label:'Print',url:'https://etsy.com/shop/artist'}],externalLinks:[{label:'Portfolio',url:'https://deviantart.com/artist'}]};
 const html=renderWebsiteGalleryGroup([gallery],gallery.id);
 assert.match(html,/<div class="website-gallery-static-purchase"><div class="website-gallery-link-group"/);
 assert.match(html,/<div data-gallery-links><div class="website-gallery-link-group"/);
 assert.match(html,/aria-label="Gallery links"/);
 assert.match(websiteGalleryViewerScript,/cloneNode\(true\)/);
});

test('the last sub-gallery page has a first-gallery link and the viewer stops at an explicit end screen',()=>{
 const last=renderWebsiteGalleryGroup(entries,'peaks');assert.match(last,/aria-label="End of galleries"><p>You’ve reached the end of these galleries/);assert.match(last,/<a href="\/portfolio\/galleries\/coast\/">Back to first gallery<\/a>/);
 const first=renderWebsiteGalleryGroup(entries,'coast');assert.doesNotMatch(first,/website-gallery-end-note/);
 assert.match(last,/data-gallery-end hidden/);assert.match(last,/data-action="restart">Back to first gallery/);
 assert.match(websiteGalleryViewerScript,/gallery===entries.length-1\)\{finish\(\);return;/);assert.match(websiteGalleryViewerScript,/playing=false;intro=false;ended=true/);assert.doesNotThrow(()=>new Function(websiteGalleryViewerScript));
});

test('teaser cards have a theme-aware light border, inner padding and extra row spacing',()=>{
 assert.match(websiteGalleryCss,/\.website-gallery-teaser\{[^}]*padding:12px;[^}]*border:1px solid color-mix/);
 assert.match(websiteGalleryCss,/\.website-gallery-tiles\{[^}]*gap:28px 16px/);
});

test('gallery teasers prefer an explicit cover without adding it to viewer photos or counts',()=>{
 const gallery={...entries[0],cover:{src:'/assets/collection-cover.jpg',alt:'Collection cover'}};
 const html=renderWebsiteGalleryGroup([gallery]),teaser=html.split('<div hidden data-gallery-data>')[0];
 assert.match(teaser,/src="\/assets\/collection-cover.jpg" alt="Collection cover"/);assert.doesNotMatch(teaser,/src="\/portfolio\/assets\/full.jpg"/);assert.match(teaser,/2 images/);
 const selected=renderWebsiteGalleryGroup([gallery],gallery.id).split('<div hidden data-gallery-data>')[0];assert.match(selected,/src="\/portfolio\/assets\/full.jpg"/);assert.doesNotMatch(selected,/src="\/assets\/collection-cover.jpg"/);
});


test('owned galleries support current-image and ZIP downloads without purchase links',()=>{
 const html=renderWebsiteGalleryGroup([{id:'owned',title:'Purchased collection',href:'/commerce/purchases',photos:[{src:'/image',thumbnail:'/thumb',alt:'Image',downloadAssetId:'image-id'}],downloads:[{label:'Download ZIP',assetId:'zip-id'}]}]);
 assert.match(html,/data-download-asset="image-id"/);assert.match(html,/data-gallery-download="zip-id"/);assert.match(html,/Download ZIP/);assert.doesNotMatch(html,/Want more\?/);
 assert.match(websiteGalleryViewerScript,/Download image/);assert.match(websiteGalleryViewerScript,/website-gallery-download/);
 const safe=renderWebsiteGalleryGroup([{id:'x',title:'Collection',href:'/commerce/purchases',photos:[],downloads:[{label:'<script>bad</script>',assetId:'" onclick="bad'}]}]);assert.doesNotMatch(safe,/<script>|data-gallery-download="" onclick=/);assert.match(safe,/&lt;script&gt;/);
});
