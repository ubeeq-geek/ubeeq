import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalAdapterSet } from '../dist/index.js';
async function fixture(t) {
 const directory=await mkdtemp(join(tmpdir(),'upload-recovery-')),configuration={databasePath:join(directory,'data.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'};
 let adapters=createLocalAdapterSet(configuration);
 t.after(async()=>{adapters.database.close();await rm(directory,{recursive:true,force:true});});
 const body=Buffer.from('Immutable uploaded source'),checksum=createHash('sha256').update(body).digest('hex');
 const upload=await adapters.storage.initiate({object:{bucket:'cell',key:'cells/cell/creators/creator/uploads/source',contentType:'text/plain',byteLength:body.length,checksum,scope:'private'},checksumAlgorithm:'sha256',expiresAt:new Date(Date.now()+60000).toISOString()});
 await adapters.storage.accept({uploadId:upload.uploadId,cellId:'cell',creatorId:'creator',operation:'upload_content',body});
 const input={uploadId:upload.uploadId,cellId:'cell',creatorId:'creator',checksum,byteLength:body.length};
 return {input,body,get adapters(){return adapters;},restart(){adapters.database.close();adapters=createLocalAdapterSet(configuration);}};
}
test('lost completion reply recovers the same immutable provider version after restart',async t=>{
 const f=await fixture(t),object=await f.adapters.storage.complete(f.input);
 f.restart();assert.deepEqual(await f.adapters.storage.recoverCompletion(f.input),object);
 await assert.rejects(()=>f.adapters.storage.complete(f.input),/already completed/);
 assert.deepEqual((await f.adapters.storage.get(object)).body,f.body);
 assert.equal(f.adapters.database.database.prepare('SELECT COUNT(*) AS n FROM ubeeq_upload_completions').get().n,1);
});
test('physical write survives failure of the completion transaction without creating another version',async t=>{
 const f=await fixture(t),db=f.adapters.database.database;
 db.exec("CREATE TRIGGER fail_upload_commit BEFORE DELETE ON ubeeq_uploads BEGIN SELECT RAISE(ABORT,'fixture terminal commit failure'); END;");
 await assert.rejects(()=>f.adapters.storage.complete(f.input),/fixture terminal commit failure/);
 assert.equal(db.prepare('SELECT state FROM ubeeq_upload_completions').get().state,'prepared');
 await assert.rejects(()=>f.adapters.storage.abort(f.input),/reconciliation/);
 db.exec('DROP TRIGGER fail_upload_commit');f.restart();
 const object=await f.adapters.storage.recoverCompletion(f.input);
 assert.equal(object.versionId,'upload-'+f.input.uploadId);assert.deepEqual((await f.adapters.storage.get(object)).body,f.body);
 assert.equal(f.adapters.database.database.prepare('SELECT COUNT(*) AS n FROM ubeeq_uploads').get().n,0);
});
test('completion receipts reject foreign scope and changed facts without losing recovery',async t=>{
 const f=await fixture(t),object=await f.adapters.storage.complete(f.input);
 for(const patch of [{cellId:'other'},{creatorId:'other'},{checksum:'0'.repeat(64)},{byteLength:1}]) await assert.rejects(()=>f.adapters.storage.recoverCompletion({...f.input,...patch}));
 await f.adapters.storage.abort(f.input);
 assert.deepEqual(await f.adapters.storage.recoverCompletion(f.input),object);
});
