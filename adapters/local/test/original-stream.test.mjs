import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,unlink,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createLocalAdapterSet} from '../dist/index.js';
import {inspectStoredObjectStream} from '@ubeeq/storage';
test('actual local original streams pin one immutable version in bounded chunks without whole-object get',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'original-stream-')),local=createLocalAdapterSet({databasePath:join(directory,'state.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'});t.after(async()=>{local.database.close();await rm(directory,{recursive:true,force:true});});
 const bytes=Buffer.alloc(2*1024*1024+131,47),checksum=createHash('sha256').update(bytes).digest('hex'),object=await local.storage.writePrivateVersion({object:{bucket:'cell',key:'cells/cell/creators/creator/originals/original',scope:'private',contentType:'application/octet-stream',byteLength:bytes.length,checksum},body:bytes});
 await local.storage.writePrivateVersion({object:{...object,versionId:undefined,checksum:createHash('sha256').update(Buffer.from('other')).digest('hex'),byteLength:5},body:Buffer.from('other')});local.storage.get=async()=>{throw Error('whole-object get forbidden');};
 const stream=await local.storage.openReadStream(object);let total=0,largest=0;try{for await(const chunk of stream.body){total+=chunk.length;largest=Math.max(largest,chunk.length);}}finally{await stream.close();}assert.equal(total,bytes.length);assert.ok(largest<=64*1024);assert.deepEqual(await inspectStoredObjectStream(local.storage,object,bytes.length),{checksumSha256:checksum,sizeBytes:bytes.length});
 await assert.rejects(local.storage.openReadStream({...object,bucket:'foreign'}));await assert.rejects(local.storage.openReadStream({...object,versionId:undefined}));await assert.rejects(local.storage.openReadStream({...object,versionId:'../escape'}));
 const path=join(directory,'objects',object.bucket,object.key,object.versionId);await unlink(path);await symlink('/etc/hosts',path);await assert.rejects(local.storage.openReadStream(object),/escapes/);
});
