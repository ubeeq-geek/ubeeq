import test from 'node:test';
import assert from 'node:assert/strict';
import { WEBSITE_THEMES, WEBSITE_PAGE_TEMPLATES } from '../dist/index.js';
test('every theme supplies accessible light and dark text and action colours',()=>{
 const luminance=c=>[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
 assert.equal(WEBSITE_THEMES.length,14);assert.equal(WEBSITE_PAGE_TEMPLATES.length,5);
 for(const theme of WEBSITE_THEMES)for(const mode of ['light','dark'])for(const role of ['text','muted','action']){
  const a=luminance(theme[mode][role]),b=luminance(theme[mode].canvas);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,`${theme.id} ${mode} ${role}`);
 }
});
