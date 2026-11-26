import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {S3CompatibleStorage} from '../dist/index.js';
import {inspectStoredObjectStream} from '@ubeeq/storage';
test('machine stream command fixture preserves exact physical version and rejects an implicit latest-version read',async()=>{
 const bytes=Buffer.from('machine original stream'),checksum=createHash('sha256').update(bytes).digest('hex'),object={bucket:'fixed',key:'cells/cell/creators/creator/originals/file',versionId:'version-one',contentType:'text/plain',byteLength:bytes.length,checksum,scope:'private'};let calls=0;
 const storage=new S3CompatibleStorage({endpoint:'http://127.0.0.1:9000',bucket:'fixed',cellId:'cell'},{async send(command){calls++;assert.deepEqual(command.input,{Bucket:object.bucket,Key:object.key,VersionId:object.versionId});return {Body:Readable.from([bytes]),VersionId:object.versionId,ContentLength:bytes.length,ContentType:object.contentType,Metadata:{scope:'private',checksum}};}});
 assert.deepEqual(await inspectStoredObjectStream(storage,object,bytes.length),{checksumSha256:checksum,sizeBytes:bytes.length});await assert.rejects(storage.openReadStream({...object,versionId:undefined}));await assert.rejects(storage.openReadStream({...object,versionId:'null'}));await assert.rejects(storage.openReadStream({...object,bucket:'foreign'}));assert.equal(calls,1);
});
