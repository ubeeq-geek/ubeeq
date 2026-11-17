import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installSqliteRetainedContentAtomic} from '../dist/index.js';

class Host {
 rows=[];publications=[];
 async update(value){this.rows=this.rows.filter(row=>row.id!==value.id).concat(value);}
 async get(id){return this.rows.find(row=>row.id===id);}
}
const attach=(store,path)=>installSqliteRetainedContentAtomic(store,path,{fields:['rows','publications'],savePublication:async value=>{store.publications=store.publications.filter(row=>row.publicationId!==value.publicationId).concat(value);}});

test('retained SQLite requires actual state fields and a publication writer',()=>{
 for(const bindings of [{fields:[],savePublication:async()=>{}},{fields:['rows','rows'],savePublication:async()=>{}},{fields:['rows']}])assert.throws(()=>installSqliteRetainedContentAtomic(new Host(),':memory:',bindings),/explicit state fields and a publication writer/);
});

test('one SQLite authority retains rich records and rolls back a caught nested failure across reopen',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'retained-atomic-')),path=join(directory,'records.sqlite'),host=new Host(),atomic=attach(host,path);
 const row={id:'work',status:'ready',revision:1,metadata:{nested:['original']}},publication={publicationId:'p',status:'draft',custom:{retained:true}};
 try{
  await atomic.run(async()=>{await host.update(row);await atomic.savePublication(publication);await atomic.put('receipt','accepted',{version:1});});
  await assert.rejects(atomic.run(async()=>{
   await host.update({...row,revision:2});
   try{await atomic.run(async()=>{await atomic.savePublication({...publication,status:'published'});await atomic.put('receipt','partial',{version:2});throw Error('Interrupted');});}catch{}
  }),/failed/);
  const reopened=new Host(),other=attach(reopened,path);
  try{assert.deepEqual(await reopened.get('work'),row);assert.deepEqual(reopened.publications,[publication]);assert.deepEqual(await other.get('receipt','accepted'),{version:1});assert.equal(await other.get('receipt','partial'),undefined);}finally{other.close();}
 }finally{atomic.close();rmSync(directory,{recursive:true,force:true});}
});
