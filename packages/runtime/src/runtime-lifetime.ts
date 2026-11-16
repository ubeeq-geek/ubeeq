import {AsyncLocalStorage} from 'node:async_hooks';
interface Entry{active:boolean;parent?:Entry}
/** Actual accepted operation lifetime only. Private awaited descendants may
 * finish during drain. Ended/detached contexts never become new admission. */
export class ReferenceRuntimeLifetime {
 private state:'open'|'closing'|'closed'='open';private active=0;
 private readonly entries=new AsyncLocalStorage<Entry>();
 private readonly idle:Array<()=>void>=[];private closing?:Promise<void>;
 get open(){return this.state==='open';}
 private live(entry:Entry){for(let current:Entry|undefined=entry;current;current=current.parent)if(!current.active)return false;return true;}
 get accepting(){const parent=this.entries.getStore();if(parent&&!this.live(parent))return false;return this.state==='open'||this.state==='closing'&&!!parent;}
 async run<Result>(operation:()=>Promise<Result>):Promise<Result>{
  if(!this.accepting)throw Error('The Core runtime is closing or closed, or its accepted operation ended.');
  const entry:Entry={active:true,parent:this.entries.getStore()};this.active++;
  try{return await this.entries.run(entry,operation);}finally{entry.active=false;this.active--;if(!this.active)for(const resolve of this.idle.splice(0))resolve();}
 }
 close(dispose:()=>Promise<void>):Promise<void>{if(this.closing)return this.closing;this.state='closing';return this.closing=Promise.resolve().then(async()=>{try{while(this.active)await new Promise<void>(resolve=>this.idle.push(resolve));await dispose();}finally{this.state='closed';}});}
}
