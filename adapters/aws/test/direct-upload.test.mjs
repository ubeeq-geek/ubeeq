import test from 'node:test';
import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import {createHash} from 'node:crypto';
import { S3DirectUploadAdapter } from '../dist/index.js';
const checksum = 'a'.repeat(64);
const object = { bucket: 'objects', key: 'cells/cell/creators/creator/uploads/owned', contentType: 'image/png', byteLength: 4, checksum, scope: 'private' };
const uploadId = Buffer.from(JSON.stringify(object)).toString('base64url');
const completion = { uploadId, cellId: 'cell', creatorId: 'creator', checksum, byteLength: 4 };
const head = () => ({ VersionId: 'immutable-version', ContentType: object.contentType, ContentLength: object.byteLength, ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'), Metadata: { checksum, scope: 'private', bytelength: '4' } });

test('the actual S3 presigner binds conditional creation, exact size, type, checksum and access metadata', async () => {
  const s3 = new S3Client({ region: 'us-east-2', credentials: { accessKeyId: 'DUMMYLOCALTEST', secretAccessKey: 'DUMMYLOCALTEST' } });
  try {
    const provider = new S3DirectUploadAdapter(s3, 'objects', 'cell');
    const result = await provider.initiate({ object, checksumAlgorithm: 'sha256', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const signed = new URL(result.parts[0].url).searchParams.get('X-Amz-SignedHeaders').split(';');
    for (const header of ['content-length', 'content-type', 'if-none-match', 'x-amz-checksum-sha256', 'x-amz-meta-checksum', 'x-amz-meta-scope', 'x-amz-meta-bytelength']) assert.ok(signed.includes(header), header + ' must be signed');
    assert.equal(result.parts[0].headers['if-none-match'], '*');
    assert.equal(result.parts[0].headers['content-length'], undefined, 'the browser derives this signed header from the Blob body');
    assert.equal(result.parts[0].headers['x-amz-meta-bytelength'], '4');
    assert.equal(result.uploadId, uploadId);
  } finally { s3.destroy(); }
});

test('completion and lost-reply recovery require the exact provider checksum, immutable version and all issued facts', async () => {
  let response = head(); const commands = [];
  const provider = new S3DirectUploadAdapter({ send: async command => { commands.push(command.input); return response; } }, 'objects', 'cell');
  assert.equal((await provider.complete(completion)).versionId, 'immutable-version');
  assert.deepEqual(await provider.recoverCompletion(completion), { ...object, versionId: 'immutable-version' });
  assert.equal(commands[0].ChecksumMode, 'ENABLED');
  for (const [field, value] of [['VersionId',undefined],['ContentLength',5],['ContentType','text/plain'],['ChecksumSHA256',undefined],['ChecksumSHA256','wrong']]) {
    response = { ...head(), [field]: value }; await assert.rejects(provider.complete(completion), /did not match/);
  }
  for (const [field, value] of [['checksum','wrong'],['scope','public'],['bytelength','5']]) {
    response = head(); response.Metadata[field] = value; await assert.rejects(provider.recoverCompletion(completion), /did not match/);
  }
  const before = commands.length;
  await assert.rejects(provider.complete({ ...completion, byteLength: 5 }), /issued request/);
  await assert.rejects(provider.complete({ ...completion, checksum: 'b'.repeat(64) }), /issued request/);
  assert.equal(commands.length, before, 'changed completion facts never reach S3');
});

test('only actual absence is an empty recovery result; denied or unavailable provider reads fail closed', async () => {
  for (const error of [Object.assign(Error('absent'),{name:'NotFound'}),Object.assign(Error('absent'),{$metadata:{httpStatusCode:404}}),Object.assign(Error('denied'),{$metadata:{httpStatusCode:403}}),Error('offline')]) {
    const provider = new S3DirectUploadAdapter({ send: async () => { throw error; } }, 'objects', 'cell');
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) assert.equal(await provider.recoverCompletion(completion), undefined);
    else await assert.rejects(provider.recoverCompletion(completion), failure => failure === error);
  }
});

test('invalid expiry, size and checksum cannot issue direct write capabilities', async () => {
  const provider = new S3DirectUploadAdapter({}, 'objects', 'cell');
  const input = { object, checksumAlgorithm: 'sha256', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await assert.rejects(provider.initiate({ ...input, expiresAt: 'invalid' }), /expiry/);
  for (const byteLength of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(provider.initiate({ ...input, object: { ...object, byteLength } }), /byte length/);
  await assert.rejects(provider.initiate({ ...input, object: { ...object, checksum: 'not-sha256' } }), /checksum/);
});

test('a lost conditional seal reply recovers one retained fence with stable provider time and proof',async()=>{
 let current,puts=0;
 const provider=new S3DirectUploadAdapter({send:async command=>{
   if(command.constructor.name==='HeadObjectCommand'){
     if(!current)throw Object.assign(Error('not found'),{name:'NotFound'});return current;
   }
   assert.equal(command.constructor.name,'PutObjectCommand');puts++;
   assert.equal(command.input.IfNoneMatch,'*');assert.equal(command.input.ContentLength,0);
   assert.equal(command.input.ChecksumSHA256,createHash('sha256').update('').digest('base64'));
   current={VersionId:'fence-version',LastModified:new Date('2026-11-12T01:02:03.000Z'),ContentLength:0,ContentType:command.input.ContentType,ChecksumSHA256:command.input.ChecksumSHA256,Metadata:command.input.Metadata};
   throw Error('Lost seal reply');
 }},'objects','cell');
 const sealed=await provider.seal(completion);assert.equal(sealed.state,'sealed');assert.equal(sealed.closedAt,'2026-11-12T01:02:03.000Z');
 assert.equal(sealed.retainedFence.versionId,'fence-version');assert.equal(sealed.retainedFence.byteLength,0);
 assert.deepEqual(await provider.seal(completion),sealed);assert.equal(puts,1);
 current.Metadata['ubeeq-upload-seal']='another-upload';await assert.rejects(provider.seal(completion),/reconciliation/);
});

test('sealing an accepted direct original returns its actual version and timestamp without a fence write',async()=>{
 let puts=0;const response={...head(),LastModified:new Date('2026-11-12T01:02:03.000Z')};
 const provider=new S3DirectUploadAdapter({send:async command=>{
   if(command.constructor.name!=='HeadObjectCommand')puts++;return response;
 }},'objects','cell');
 const result=await provider.seal(completion);assert.equal(result.state,'completed');assert.equal(result.object.byteLength,4);
 assert.equal(result.object.writtenAt,response.LastModified.toISOString());assert.equal(puts,0);
});

test('denied seal reads do not write a fence or turn unknown storage into empty storage',async()=>{
 let writes=0;const denied=Object.assign(Error('denied'),{$metadata:{httpStatusCode:403}});
 const provider=new S3DirectUploadAdapter({send:async command=>{if(command.constructor.name!=='HeadObjectCommand')writes++;throw denied;}},'objects','cell');
 await assert.rejects(provider.seal(completion),error=>error===denied);assert.equal(writes,0);
});
