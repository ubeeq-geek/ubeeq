import {Readable} from 'node:stream';

/** Actual client ownership only, never an authorization or provider retry port.
 * One owner tracks original SDK sends (including their original retries) and
 * Node streaming reply bodies. Closing rejects new sends, drains accepted work,
 * then destroys every genuinely owned client exactly once. */
export class OwnedAwsClientLifetime {
 private state:'open'|'closing'|'closed'='open';
 private active=0;private readonly idle:Array<()=>void>=[];
 private readonly clients=new Set<{destroy():void}>();
 private closing?:Promise<void>;
 own<Client extends {destroy():void}>(client:Client):Client{if(this.state!=='open')throw Error('The AWS adapter set is closing or closed.');this.clients.add(client);return client;}
 private enter(){if(this.state!=='open')throw Error('The AWS adapter set is closing or closed.');this.active++;let completed=false;return()=>{if(completed)return;completed=true;this.active--;if(!this.active)for(const resolve of this.idle.splice(0))resolve();};}
 async send<Result extends {output:object}>(operation:()=>Promise<Result>):Promise<Result>{
  const leave=this.enter();
  try{
   const result=await operation(),output=result.output;
   // The actual Node S3 body remains a live client resource AFTER headers. A
   // byte reader or its original close owns completion; do not abort it early.
   const body='Body'in output?output.Body:undefined;
   if(body instanceof Readable&&!body.readableEnded&&!body.destroyed){
    const done=()=>{body.off('end',done);body.off('close',done);body.off('error',done);leave();};body.once('end',done);body.once('close',done);body.once('error',done);
   }else leave();
   return result;
  }catch(error){leave();throw error;}
 }
 close():Promise<void>{
  if(this.closing)return this.closing;this.state='closing';
  return this.closing=Promise.resolve().then(async()=>{while(this.active)await new Promise<void>(resolve=>this.idle.push(resolve));let failed=false,failure:unknown;for(const client of this.clients)try{client.destroy();}catch(error){if(!failed){failed=true;failure=error;}}this.clients.clear();this.state='closed';if(failed)throw failure;});
 }
}
