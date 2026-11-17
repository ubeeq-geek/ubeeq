import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalAdapterSet} from '../dist/index.js';

test('SQLite inventories retain legacy rows and reject insert, update and delete races without partial writes',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'repository-snapshot-')),configuration={databasePath:join(directory,'records.sqlite'),dataDirectory:directory,publicBaseUrl:'http://localhost',cellId:'cell'};
 const first=createLocalAdapterSet(configuration),second=createLocalAdapterSet(configuration),scope={instanceId:'instance',homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:'2026-01-01',routingRevision:1};
 try{
  await first.repositories.publications.create({id:'legacy',...scope,workId:'work',destination:'native',status:'live',opaqueLegacy:{keep:['all','fields']}});
  // Model an existing inventory before the additive marker migration.
  first.database.database.prepare('DELETE FROM ubeeq_repository_versions').run();
  const legacy=await first.repositories.publications.snapshot();assert.equal(legacy.items.length,1);assert.deepEqual(legacy.items[0].opaqueLegacy,{keep:['all','fields']});
  await first.repositories.transaction(async transaction=>{await legacy.bind(transaction);assert.equal((await first.repositories.publications.list({limit:100},{transaction})).items[0].id,'legacy');});
  for(const operation of ['insert','update','remove']){
   const snapshot=await first.repositories.publications.snapshot();
   if(operation==='insert')await second.repositories.publications.create({id:'new',...scope,workId:'work',destination:'native',status:'live'});
   else if(operation==='update')await second.repositories.publications.update('new',1,{status:'removed'});
   else await second.repositories.publications.remove('new',2);
   await assert.rejects(first.repositories.transaction(async transaction=>{
    await first.repositories.auditEvents.create({id:operation,...scope,action:'must.rollback',payload:{}},{transaction});
    await assert.rejects(snapshot.bind(transaction),{name:'OptimisticConcurrencyError'});
   }),/rollback-only/);
   assert.deepEqual((await first.repositories.auditEvents.list({limit:100})).items,[]);
  }
 }finally{first.database.close();second.database.close();rmSync(directory,{recursive:true,force:true});}
});

test('SQLite snapshots preserve cell filtering and guard a large source inventory with one complete read',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'source-snapshot-')),configuration={databasePath:join(directory,'records.sqlite'),dataDirectory:directory,publicBaseUrl:'http://localhost',cellId:'cell'},local=createLocalAdapterSet(configuration);
 try{
  const scope={instanceId:'instance',homeCellId:'cell',dataHomeRegion:'local',dataHomeAssignedAt:'2026-01-01',routingRevision:1,creatorId:'creator',workId:'work',mimeType:'image/png',checksum:'checksum',objectVersion:'source',status:'ready'};
  await local.repositories.transaction(async transaction=>{for(let i=0;i<1001;i++)await local.repositories.assets.create({id:'asset-'+String(i).padStart(4,'0'),...scope},{transaction});});
  await local.repositories.assets.repository.create({id:'foreign',...scope,homeCellId:'other-cell'});
  const snapshot=await local.repositories.assets.snapshot();assert.equal(snapshot.items.length,1001);assert.ok(snapshot.items.every(asset=>asset.homeCellId==='cell'));
  await local.repositories.transaction(async transaction=>{await snapshot.bind(transaction);assert.equal((await local.repositories.assets.list({limit:100},{transaction})).items.length,100);});
  await local.repositories.assets.create({id:'late',...scope,status:'pending'});
  await assert.rejects(local.repositories.transaction(transaction=>snapshot.bind(transaction)),{name:'OptimisticConcurrencyError'});
 }finally{local.database.close();rmSync(directory,{recursive:true,force:true});}
});
