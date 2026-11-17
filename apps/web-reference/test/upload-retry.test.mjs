import assert from 'node:assert/strict';
import test from 'node:test';
import { Script, createContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createReferenceApp } from '../src/server.mjs';

test('the served reference upload script retries the same intent and verifies a direct-write conflict', async t => {
  const app = createReferenceApp(); await new Promise(resolve => app.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const html = await (await fetch('http://127.0.0.1:' + app.address().port + '/workspace')).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = new Map(), calls = []; let initiations = 0, completions = 0, puts = 0;
  const element = id => { if (!nodes.has(id)) nodes.set(id,{value:'',textContent:'',disabled:false}); return nodes.get(id); };
  const source = new Blob(['reference source'],{type:'text/plain'}); element('file').files = [source];
  const context = createContext({ document:{getElementById:element}, localStorage:{getItem:key=>key.endsWith('.work')?'saved-work':'',setItem(){}}, crypto:webcrypto, Uint8Array, btoa, Blob,
    fetch:async(url,options)=>{
      calls.push({url,...options});
      if(url==='/api/v1/uploads') return new Response(JSON.stringify({upload:{uploadId:'owned',completed:++initiations===2,parts:[{partNumber:1,url:'https://objects.test/upload',headers:{'if-none-match':'*'}}]}}));
      if(url==='https://objects.test/upload'){puts++;assert.equal(options.headers['if-none-match'],'*');return new Response('',{status:412});}
      if(++completions===1)return new Response(JSON.stringify({error:{message:'Not yet verified'}}),{status:409});
      return new Response(JSON.stringify({queuePending:true}));
    },
  });
  new Script(script).runInContext(context);
  await element('uploadFile').onclick(); assert.match(element('output').textContent,/Direct object upload failed: 412/);assert.equal(element('uploadFile').disabled,false);
  await element('uploadFile').onclick();assert.match(element('uploadStatus').textContent,/waiting for the queue/);
  const requests = calls.filter(call=>call.url==='/api/v1/uploads').map(call=>JSON.parse(call.body));
  assert.equal(requests[0].idempotencyKey,requests[1].idempotencyKey);assert.equal(puts,1);assert.equal(completions,2);
});
