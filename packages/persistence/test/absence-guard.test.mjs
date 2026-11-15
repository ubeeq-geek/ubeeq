import test from 'node:test';
import assert from 'node:assert/strict';
import {CellScopedRepository, OptimisticConcurrencyError} from '../dist/index.js';

test('cell-scoped absence guards check physical identity even when get hides a foreign row',async()=>{
  const transaction={id:'transaction'},foreign={id:'occupied',homeCellId:'other-cell'};
  const underlying={
    async get(id){return id===foreign.id?foreign:undefined;},
    async checkAbsent(id,options){assert.equal(this,underlying);assert.equal(options.transaction,transaction);if(id===foreign.id)throw new OptimisticConcurrencyError(id,0);}
  };
  const local=new CellScopedRepository(underlying,'local-cell');
  assert.equal(await local.get('occupied'),undefined);
  await assert.rejects(local.checkAbsent('occupied',{transaction}),error=>error.name==='OptimisticConcurrencyError'&&error.expectedRevision===0);
  await local.checkAbsent('absent',{transaction});
  assert.equal(new CellScopedRepository({get:underlying.get},'local-cell').checkAbsent,undefined);
});
