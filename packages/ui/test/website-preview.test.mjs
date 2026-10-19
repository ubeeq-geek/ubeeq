import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebsiteZip} from '@ubeeq/portability';
import {readWebsitePreviewArchive,websitePreviewHtml} from '../dist/website-preview.js';
test('complete previews preserve pages and binary assets once in a bounded archive',async()=>{
 const source=new Map([['index.html',new TextEncoder().encode('<h1>Home</h1>')],['about/index.html',new TextEncoder().encode('<h1>About</h1>')],['assets/image.png',new Uint8Array([0,255,1,128])]]);
 const files=await readWebsitePreviewArchive(new Blob([createWebsiteZip(source)]));
 assert.equal(atob(files['about/index.html']),'<h1>About</h1>');assert.deepEqual(Uint8Array.from(atob(files['assets/image.png']),c=>c.charCodeAt(0)),source.get('assets/image.png'));
 const html=websitePreviewHtml(files,'about/index.html');assert.match(html,/website-preview.navigate/);assert.doesNotMatch(html,/allow-same-origin/);assert.match(html,/script-src 'nonce-/);assert.match(html,/connect-src 'none'/);
 assert.throws(()=>websitePreviewHtml(files,'missing.html'));
 await assert.rejects(readWebsitePreviewArchive(new Blob(['not a zip'])));
 const unsafe=Buffer.from(createWebsiteZip(new Map([['index.html',new Uint8Array()],['safeimg.html',new Uint8Array()]])));unsafe.write('../evil.html',unsafe.indexOf('safeimg.html'));
 await assert.rejects(readWebsitePreviewArchive(new Blob([unsafe])));
});
