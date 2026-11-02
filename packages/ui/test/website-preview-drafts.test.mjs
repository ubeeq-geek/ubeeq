import test from 'node:test';
import assert from 'node:assert/strict';
import {saveWebsitePreviewDrafts} from '../dist/website-preview-drafts.js';
const draft=id=>({id,workspaceId:'creator',revision:2,blocks:[]});
test('preview saves documents concurrently, keeps successes, waits for failures and retries only failed drafts',async()=>{
 const drafts=new Map(Array.from({length:8},(_,i)=>[String(i),draft(String(i))])),baselines=new Map();let active=0,peak=0;const calls=[];
 await assert.rejects(saveWebsitePreviewDrafts(drafts,baselines,async(doc,revision)=>{
   assert.equal(revision,2);assert.equal(doc.revision,3);calls.push(doc.id);peak=Math.max(peak,++active);
   await new Promise(resolve=>setImmediate(resolve));active--;
   if(doc.id==='1')throw new Error('save failed');return doc;
 }),/save failed/);
 assert.equal(active,0);assert.equal(peak,3);assert.equal(calls.length,8);assert.deepEqual([...drafts.keys()],['1']);assert.equal(baselines.size,7);
 await saveWebsitePreviewDrafts(drafts,baselines,async doc=>{assert.equal(doc.id,'1');return doc;});assert.equal(drafts.size,0);assert.equal(baselines.size,8);
});
test('unchanged documents need no save',async()=>{
 const doc=draft('same'),drafts=new Map([['same',doc]]);
 await saveWebsitePreviewDrafts(drafts,new Map([['same',JSON.stringify(doc)]]),async()=>assert.fail('Unchanged document'));
});
