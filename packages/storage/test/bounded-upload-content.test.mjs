import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeBoundedUploadContent} from '../dist/index.js';
const body=Buffer.from('Bounded internal output');
const upload={uploadId:'owned-provider-session',object:{bucket:'cell',key:'cells/cell/creators/creator/exports/output',byteLength:body.length,checksum:createHash('sha256').update(body).digest('hex'),contentType:'text/plain',scope:'private'},expiresAt:new Date(Date.now()+60_000).toISOString()};
const scope={cellId:'cell',creatorId:'creator',body};
test('internal proxy writes authenticate the exact provider session and reject changed facts before sending bytes',async()=>{
 let accepted;const uploads={async accept(input){accepted=input;}};
 await writeBoundedUploadContent({...scope,upload,uploads});assert.equal(accepted.uploadId,upload.uploadId);assert.equal(accepted.operation,'upload_content');assert.deepEqual(accepted.body,body);
 for(const patch of [{body:Buffer.from('changed')},{cellId:'foreign'},{creatorId:'foreign'},{upload:{...upload,object:{...upload.object,checksum:'0'.repeat(64)}}}]){accepted=undefined;await assert.rejects(()=>writeBoundedUploadContent({...scope,upload,uploads,...patch}),/conflicts/);assert.equal(accepted,undefined);}
});
test('HTTPS transport preserves provider headers, exact bytes and rejects redirects and multipart shapes',async()=>{
 const previous=globalThis.fetch;let sent;globalThis.fetch=async(url,options)=>{sent={url,options};return new Response(null,{status:200});};
 try{
  const direct={...upload,parts:[{partNumber:1,url:'https://storage.example.test/owned-signed-request',headers:{'if-none-match':'*','content-type':'text/plain','x-amz-checksum-sha256':'signed-digest'},expiresAt:upload.expiresAt}]};
  await writeBoundedUploadContent({...scope,upload:direct,uploads:{}});assert.deepEqual(sent.options.headers,direct.parts[0].headers);assert.deepEqual(sent.options.body,body);assert.equal(sent.options.redirect,'error');assert.equal(sent.options.method,'PUT');
  for(const parts of [[],[...direct.parts,...direct.parts],[{...direct.parts[0],partNumber:2}],[{...direct.parts[0],url:'http://storage.example.test/owned'}]]){sent=undefined;await assert.rejects(()=>writeBoundedUploadContent({...scope,upload:{...direct,parts},uploads:{}}),/bounded HTTPS/);assert.equal(sent,undefined);}
 }finally{globalThis.fetch=previous;}
});
test('a failed PUT response stays uncertain for its caller to recover rather than becoming a successful write',async()=>{
 const previous=globalThis.fetch;globalThis.fetch=async()=>new Response(null,{status:412});
 try{await assert.rejects(()=>writeBoundedUploadContent({...scope,upload:{...upload,parts:[{partNumber:1,url:'https://storage.example.test/owned',expiresAt:upload.expiresAt}]},uploads:{}}),/requires recovery/);}finally{globalThis.fetch=previous;}
});
