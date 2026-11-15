import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalAdapterSet} from '../dist/index.js';
import {LocalUploadStreamCustody} from '../dist/upload-stream-custody.js';
import {removeOwnedLocalVersion} from '../dist/owned-version-removal.js';
import {validateOwnedVersionAbsence} from '@ubeeq/storage';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t,{legacy=false}={}){
 const directory=await mkdtemp(join(tmpdir(),'actual-local-finalization-fence-')),config={databasePath:join(directory,'core.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://127.0.0.1'},first=createLocalAdapterSet(config),second=createLocalAdapterSet(config);t.after(async()=>{first.database.close();second.database.close();await rm(directory,{recursive:true,force:true});});
 const body=Buffer.from('Actual owned finite upload bytes '+randomUUID()),checksum=createHash('sha256').update(body).digest('hex'),object={bucket:'cell',key:'cells/cell/creators/creator/exports/exact-version',contentType:'video/mp4',byteLength:body.byteLength,checksum,scope:'private'},upload=await first.storage.initiate({object,checksumAlgorithm:'sha256',expiresAt:new Date(Date.now()+60_000).toISOString(),idempotencyKey:randomUUID()}),input={uploadId:upload.uploadId,cellId:'cell',creatorId:'creator'},completion={...input,checksum,byteLength:body.byteLength};
 if(legacy){first.database.database.prepare('UPDATE ubeeq_uploads SET body=? WHERE id=?').run(body,upload.uploadId);}else await first.storage.acceptStream({...input,operation:'upload_content',body:(async function*(){yield body;})()});
 const path=join(directory,'objects','cell',object.key,'upload-'+upload.uploadId);return {directory,first,second,body,upload,input,completion,path};
}
async function absent(path){await assert.rejects(stat(path),{code:'ENOENT'});await assert.rejects(stat(path+'.json'),{code:'ENOENT'});}

test('separate actual Local connections: a stale prepared recovery cannot recreate sidecar after completed version removal',{timeout:30_000},async t=>{
 const f=await fixture(t);f.first.database.database.exec("CREATE TRIGGER interrupt_first_completion BEFORE UPDATE OF state ON ubeeq_upload_completions WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'actual setup interruption after physical publication'); END");await assert.rejects(f.first.storage.complete(f.completion),/actual setup interruption/);f.first.database.database.exec('DROP TRIGGER interrupt_first_completion');assert.equal(f.first.database.database.prepare('SELECT state FROM ubeeq_upload_completions WHERE id=?').get(f.input.uploadId).state,'prepared');
 const entered=deferred(),release=deferred(),verify=LocalUploadStreamCustody.prototype.verify;let captured=false;t.mock.method(LocalUploadStreamCustody.prototype,'verify',async function(path,object){const result=await verify.call(this,path,object);if(this.local===f.first.database&&!captured&&!path.includes('/.upload-content/')){captured=true;entered.resolve();await release.promise;}return result;});
 t.after(()=>release.resolve());const stale=f.first.storage.recoverCompletion(f.completion);void stale.catch(()=>{});await entered.promise;const completed=await f.second.storage.recoverCompletion(f.completion),request={object:completed,upload:f.upload,cellId:'cell',creatorId:'creator'},proof=await removeOwnedLocalVersion(f.second.database,request);validateOwnedVersionAbsence(request,proof);await absent(f.path);release.resolve();await assert.rejects(stale,/permanently sealed/);await absent(f.path);assert.deepEqual(await removeOwnedLocalVersion(f.second.database,request),proof);assert.equal(f.second.database.database.prepare('SELECT state FROM ubeeq_upload_completions WHERE id=?').get(f.input.uploadId).state,'completed');
});

test('separate actual Local connections: stale historical BLOB completion cannot republish full bytes after removal',{timeout:30_000},async t=>{
 const f=await fixture(t,{legacy:true}),entered=deferred(),release=deferred(),verify=LocalUploadStreamCustody.prototype.verify;let captured=false;t.mock.method(LocalUploadStreamCustody.prototype,'verify',async function(path,object){const result=await verify.call(this,path,object);if(this.local===f.first.database&&!captured&&path.includes('/.upload-content/')){captured=true;entered.resolve();await release.promise;}return result;});
 t.after(()=>release.resolve());const stale=f.first.storage.complete(f.completion);void stale.catch(()=>{});await entered.promise;const completed=await f.second.storage.complete(f.completion),request={object:completed,upload:f.upload,cellId:'cell',creatorId:'creator'},proof=await removeOwnedLocalVersion(f.second.database,request);validateOwnedVersionAbsence(request,proof);await absent(f.path);release.resolve();await assert.rejects(stale,/permanently sealed/);await absent(f.path);await assert.rejects(f.first.storage.recoverCompletion(f.completion),{code:'ENOENT'});assert.equal(f.second.database.database.prepare('SELECT COUNT(*) AS n FROM ubeeq_upload_stream_custody WHERE id=?').get(f.input.uploadId).n,0);
});
