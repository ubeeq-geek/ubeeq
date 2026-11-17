import test from 'node:test';
import assert from 'node:assert/strict';
import {publishReferenceWhenReady} from '../../../examples/aws-serverless/single-cell/reference-publication-retry.mjs';
const workId='actual-reference-work',idempotencyKey='actual-stable-publication',receipt=idempotent=>({intent:{id:'actual-intent',workId,destination:'reference'},publication:{id:'actual-publication',workId,destination:'reference',status:'live'},work:{id:workId,status:'ready'},idempotent});
test('worker processing and revision conflicts retry the same key and require the actual receipt',async()=>{
 const requests=[],responses=[{response:{status:409},value:{error:{code:'processing_incomplete'}}},{response:{status:409},value:{error:{code:'revision_conflict'}}},{response:{status:201},value:receipt(false)}];let waits=0;
 const result=await publishReferenceWhenReady(async(path,options)=>{requests.push({path,options});return responses.shift();},{workId,idempotencyKey,wait:async()=>{waits++;}});
 assert.equal(result.publication.id,'actual-publication');assert.equal(waits,2);assert.equal(requests.length,3);
 for(const request of requests){assert.equal(request.options.headers['idempotency-key'],idempotencyKey);assert.equal(request.path,'/v1/works/'+workId+'/publications');}
 assert.deepEqual(await publishReferenceWhenReady(async()=>({response:{status:200},value:receipt(true)}),{workId,idempotencyKey}),receipt(true));
});
test('false healthy responses, foreign receipts and real failures cannot pass publication acceptance',async()=>{
 for(const value of [{ok:true},receipt(false),{...receipt(true),publication:{...receipt(true).publication,workId:'foreign-work'}}])await assert.rejects(publishReferenceWhenReady(async()=>({response:{status:200},value}),{workId,idempotencyKey}),/actual matching receipt/);
 for(const status of [400,403,500])await assert.rejects(publishReferenceWhenReady(async()=>({response:{status},value:{error:{code:'revision_conflict'}}}),{workId,idempotencyKey}),/Publication failed/);
 let calls=0;await assert.rejects(publishReferenceWhenReady(async()=>{calls++;return{response:{status:409},value:{error:{code:'revision_conflict'}}};},{workId,idempotencyKey,attempts:2,wait:async()=>{}}),/deadline/);assert.equal(calls,2);
});
