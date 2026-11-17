import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {createLocalAdapterSet} from '../dist/index.js';

const fixture=()=>{
  const directory=mkdtempSync(join(tmpdir(),'ubeeq-absence-'));
  const config={databasePath:join(directory,'state.sqlite'),dataDirectory:directory,cellId:'cell',publicBaseUrl:'http://localhost'};
  const adapters=createLocalAdapterSet(config),home={homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:'2026-01-01',routingRevision:1};
  const record=id=>({id,...home,instanceId:'instance',namespace:'authority',scopeId:'users',key:id,value:{active:false}});
  return {...adapters,config,record,close:()=>{adapters.database.close();rmSync(directory,{recursive:true,force:true});}};
};

test('SQLite absence guards coalesce, reject hidden existing rows, and roll back caught contradictions',async()=>{
  const f=fixture(),repository=f.repositories.hostRecords;
  try{
    await f.repositories.transaction(async transaction=>{
      await repository.checkAbsent('missing',{transaction});await repository.checkAbsent('missing',{transaction});
      await repository.create(f.record('independent'),{transaction});
    });
    await repository.repository.create({...f.record('foreign'),homeCellId:'other'});
    assert.equal(await repository.get('foreign'),undefined);
    await assert.rejects(f.repositories.transaction(async transaction=>{
      await repository.create(f.record('must-rollback'),{transaction});
      await assert.rejects(repository.checkAbsent('foreign',{transaction}),error=>error.name==='OptimisticConcurrencyError'&&error.expectedRevision===0);
    }),/rollback-only/);
    assert.equal(await repository.get('must-rollback'),undefined);
    for(const order of ['guard-write','write-guard','contradiction']){
      await assert.rejects(f.repositories.transaction(async transaction=>{
        await repository.create(f.record('companion-'+order),{transaction});
        if(order==='write-guard'){
          await repository.create(f.record(order),{transaction});
          await assert.rejects(repository.checkAbsent(order,{transaction}),/guard or write/);
        }else{
          await repository.checkAbsent(order,{transaction});
          if(order==='guard-write')await assert.rejects(repository.create(f.record(order),{transaction}),/guarded item/);
          else await assert.rejects(repository.repository.checkRevision(order,1,{transaction}),{name:'OptimisticConcurrencyError'});
        }
      }),/rollback-only/);
      assert.equal(await repository.get('companion-'+order),undefined);assert.equal(await repository.get(order),undefined);
    }
    let ended;await f.repositories.transaction(async transaction=>{ended=transaction;await repository.checkAbsent('ended',{transaction});});
    await assert.rejects(repository.checkAbsent('ended',{transaction:ended}),/not active/);
  }finally{f.close();}
});

test('SQLite absence stays protected from an actual independent SQL writer until accepting commit',async t=>{
  const f=fixture(),repository=f.repositories.hostRecords;
  t.after(()=>f.close());
  await f.repositories.transaction(async transaction=>{
    await repository.checkAbsent('late-role',{transaction});
    const worker=new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');
      const database=new DatabaseSync(workerData.path);
      try{
        database.exec('PRAGMA busy_timeout = 50');
        const row=workerData.row,now='2026-01-01';
        try{database.prepare('INSERT INTO ubeeq_records(repository,id,revision,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('hostRecords',row.id,1,JSON.stringify({...row,revision:1,createdAt:now,updatedAt:now}),now,now);parentPort.postMessage({blocked:false});}
        catch(error){parentPort.postMessage({blocked:/locked|busy/i.test(error.message)});}
      }finally{database.close();}
    `,{eval:true,workerData:{path:f.config.databasePath,row:f.record('late-role')}});
    t.after(()=>worker.terminate());
    const result=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});
    assert.equal(result.blocked,true);
    await repository.create(f.record('accepted'),{transaction});
  });
  assert.ok(await repository.get('accepted'));
  await repository.create(f.record('late-role'));
  await assert.rejects(f.repositories.transaction(async transaction=>{
    await repository.create(f.record('rejected'),{transaction});
    await repository.checkAbsent('late-role',{transaction});
  }),error=>error.name==='OptimisticConcurrencyError'&&error.expectedRevision===0);
  assert.equal(await repository.get('rejected'),undefined);
});
