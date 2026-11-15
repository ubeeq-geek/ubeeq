import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectStoredObjectStream} from '../dist/index.js';
const body=Buffer.from('versioned bytes'),object={bucket:'bucket',key:'key',versionId:'version',scope:'private',byteLength:body.length,contentType:'text/plain',checksum:createHash('sha256').update(body).digest('hex')};
test('original stream verification closes transport on truncated/excess bytes, changed checksum or metadata',async()=>{
 for(const patch of [{chunks:[body.subarray(1)]},{chunks:[Buffer.concat([body,body])]},{chunks:[Buffer.alloc(body.length)]},{header:{versionId:'other'}},{header:{bucket:'foreign'}}]){
  let closed=0;const storage={async openReadStream(){return {object:{...object,...patch.header},body:(async function*(){yield* patch.chunks??[body];})(),async close(){closed++;}};}};
  await assert.rejects(inspectStoredObjectStream(storage,object,object.byteLength));assert.equal(closed,1);
 }
});
