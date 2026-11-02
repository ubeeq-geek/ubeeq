import type {WebsiteDocument} from '@ubeeq/core';
/** Wait for all in-flight saves before exposing retryable drafts or saving the website revision. */
export async function saveWebsitePreviewDrafts(drafts:Map<string,WebsiteDocument>,baselines:Map<string,string>,save:(document:WebsiteDocument,expectedRevision:number)=>Promise<WebsiteDocument>):Promise<void> {
  const pending=[...drafts].filter(([id,doc])=>JSON.stringify(doc)!==baselines.get(id));
  let next=0;const errors:unknown[]=[];
  await Promise.all(Array.from({length:Math.min(3,pending.length)},async()=>{
    while(next<pending.length){
      const [id,doc]=pending[next++];
      try{
        const saved=await save({...doc,revision:doc.revision+1},doc.revision);
        baselines.set(id,JSON.stringify(saved));
        if(drafts.get(id)===doc)drafts.delete(id);
      }catch(error){errors.push(error);}
    }
  }));
  if(errors.length)throw errors[0];
}
