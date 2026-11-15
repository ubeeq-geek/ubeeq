import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {S3ObjectStorage} from '../dist/index.js';
import {inspectStoredObjectStream} from '@ubeeq/storage';
test('AWS stream command fixture pins the configured bucket/key/version and never materializes its body',async()=>{
 const bytes=Buffer.from('exact version stream'),checksum=createHash('sha256').update(bytes).digest('hex'),expected={bucket:'originals',key:'cells/cell/creators/creator/originals/file',versionId:'provider-version',contentType:'text/plain',byteLength:bytes.length,checksum,scope:'private'};let calls=0;
 const storage=new S3ObjectStorage({async send(command){calls++;assert.equal(command.constructor.name,'GetObjectCommand');assert.deepEqual(command.input,{Bucket:expected.bucket,Key:expected.key,VersionId:expected.versionId});const body=Readable.from([bytes]);body.transformToByteArray=()=>{throw Error('whole body conversion forbidden');};return {Body:body,VersionId:expected.versionId,ContentType:expected.contentType,ContentLength:bytes.length,Metadata:{scope:'private',checksum}};}},expected.bucket,'cell');
 assert.deepEqual(await inspectStoredObjectStream(storage,expected,bytes.length),{checksumSha256:checksum,sizeBytes:bytes.length});assert.equal(calls,1);await assert.rejects(storage.openReadStream({...expected,bucket:'foreign'}));await assert.rejects(storage.openReadStream({...expected,versionId:undefined}));await assert.rejects(storage.openReadStream({...expected,versionId:'null'}));assert.equal(calls,1);
 const body=Readable.from([bytes]),wrong=new S3ObjectStorage({async send(){return {Body:body,VersionId:'different',ContentLength:bytes.length};}},expected.bucket,'cell');await assert.rejects(wrong.openReadStream(expected),/exact immutable/);assert.equal(body.destroyed,true);
});
