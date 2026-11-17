import {setTimeout} from 'node:timers/promises';
/** Bounded acceptance-client retry, never a substitute for the actual receipt. */
export async function publishReferenceWhenReady(call,{workId,idempotencyKey,attempts=30,wait=()=>setTimeout(2000)}){
 if(typeof idempotencyKey!=='string'||!idempotencyKey||idempotencyKey.length>200||!Number.isSafeInteger(attempts)||attempts<1)throw Error('A stable bounded publication request is required.');
 for(let attempt=0;attempt<attempts;attempt++){
  const result=await call('/v1/works/'+encodeURIComponent(workId)+'/publications',{method:'POST',headers:{'idempotency-key':idempotencyKey},body:{destination:'reference'}}),value=result.value;
  if(result.response.status===200||result.response.status===201){
   if(!value?.intent?.id||value.intent.workId!==workId||value.intent.destination!=='reference'||!value?.publication?.id||value.publication.workId!==workId||value.publication.destination!=='reference'||value.publication.status!=='live'||value.work?.id!==workId||value.work.status!=='ready'||value.idempotent!==(result.response.status===200))throw Error('The reference publication did not return its actual matching receipt.');
   return value;
  }
  const code=value?.error?.code;
  if(result.response.status!==409||!['processing_incomplete','revision_conflict'].includes(code))throw Error('Publication failed: '+result.response.status+' '+(typeof code==='string'&&/^[a-z_]+$/.test(code)?code:'invalid_response'));
  if(attempt+1<attempts)await wait();
 }
 throw Error('The Work did not become publishable before the acceptance deadline.');
}
