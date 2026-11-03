import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createWebsiteZip} from '@ubeeq/portability';
import {streamCommerceZip,commercePackageSize} from '../dist/index.js';
const files=new Map([['z-B.png',Buffer.from('second')],['A-first.png',Buffer.from('first')]]);
const assets=[...files].map(([name,bytes])=>({id:name.split('-')[0],label:name.slice(name.indexOf('-')+1),byteLength:bytes.length,checksum:createHash('sha256').update(bytes).digest('hex')}));
test('streamed ZIP is identical to the portable ZIP writer and reads one original at a time',async()=>{
 let active=0,maximum=0,reads=0;const chunks=[];
 for await(const chunk of streamCommerceZip(assets,async asset=>{active++;maximum=Math.max(maximum,active);reads++;await Promise.resolve();active--;return files.get(asset.id+'-'+asset.label);},10000))chunks.push(chunk);
 const zip=Buffer.concat(chunks);assert.deepEqual(zip,Buffer.from(createWebsiteZip(files)));assert.equal(zip.length,commercePackageSize(assets));assert.equal(maximum,1);assert.equal(reads,2);
});
test('rejects corrupt sources and format or explicit allowance limits',async()=>{
 await assert.rejects(async()=>{for await(const chunk of streamCommerceZip(assets,async()=>Buffer.from('bad'),10000))void chunk;},/content_unavailable/);
 await assert.rejects(async()=>{for await(const chunk of streamCommerceZip(assets,async()=>{throw Error('must not read');},1))void chunk;},/creator_storage_limit/);
 assert.throws(()=>commercePackageSize([{...assets[0],byteLength:0xffffffff}]),/package_format_limit/);
});
