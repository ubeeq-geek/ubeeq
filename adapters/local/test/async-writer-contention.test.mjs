import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalSqliteDatabase} from '../dist/index.js';
const deferred=()=>{let resolve;return{promise:new Promise(done=>{resolve=done;}),resolve};};
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'local-async-writers-'));
 const configuration={databasePath:join(directory,'core.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://127.0.0.1'};
 const first=new LocalSqliteDatabase(configuration),second=new LocalSqliteDatabase(configuration);
 first.database.exec('CREATE TABLE writer_probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)');
 t.after(async()=>{second.close();first.close();await rm(directory,{recursive:true,force:true});});
 return{first,second};
}
test('a waiting independent writer yields so the current writer can commit on the same event loop',{timeout:10000},async t=>{
 const {first,second}=await fixture(t),entered=deferred(),release=deferred();
 const holding=first.transaction(async()=>{first.database.prepare('INSERT INTO writer_probe VALUES (1, 1)').run();entered.resolve();await release.promise;});
 await entered.promise;const timer=setTimeout(release.resolve,20);
 try{await second.transaction(async()=>{second.database.prepare('UPDATE writer_probe SET value=value+1 WHERE id=1').run();});}
 finally{clearTimeout(timer);release.resolve();await holding;}
 assert.equal(first.database.prepare('SELECT value FROM writer_probe WHERE id=1').get().value,2);
});
test('independent writer acquisition preserves the finite busy deadline and original SQLite error',{timeout:10000},async t=>{
 const {first,second}=await fixture(t),entered=deferred(),release=deferred();
 const holding=first.transaction(async()=>{entered.resolve();await release.promise;});await entered.promise;
 const started=Date.now();let invoked=false;
 try{await assert.rejects(second.transaction(async()=>{invoked=true;}),error=>error.errcode===5&&error.code==='ERR_SQLITE_ERROR');}
 finally{release.resolve();await holding;}
 assert.equal(invoked,false);assert.ok(Date.now()-started>=4500);assert.ok(Date.now()-started<8000);
});
