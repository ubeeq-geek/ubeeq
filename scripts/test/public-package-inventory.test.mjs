import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publicPackageInventory,validatePublishSelection} from '../public-package-inventory.mjs';
test('release inventory includes implicit public packages, adapters and deployment workspaces while excluding private apps',async()=>{
 const root=await mkdtemp(join(tmpdir(),'public-package-inventory-'));
 try{
  await writeFile(join(root,'package.json'),JSON.stringify({workspaces:['packages/*','adapters/*','deployments/*/*','apps/*']}));
  for(const [directory,name,privacy] of [['packages/runtime','@ubeeq/runtime',undefined],['adapters/provider','@ubeeq/provider',false],['deployments/machine/compact','@ubeeq/deployment-machine',false],['apps/reference','@ubeeq/reference',true]]){
   const path=join(root,directory);await mkdir(path,{recursive:true});await writeFile(join(path,'package.json'),JSON.stringify({name,version:'0.1.0',license:'MIT',...(privacy===undefined?{}:{private:privacy})}));
  }
  const inventory=await publicPackageInventory(root),names=inventory.map(p=>p.manifest.name);
  assert.deepEqual(names,['@ubeeq/deployment-machine','@ubeeq/provider','@ubeeq/runtime']);
  const complete=names.map(name=>'--workspace '+name).join(' ');assert.equal(validatePublishSelection(inventory,complete),3);
  assert.throws(()=>validatePublishSelection(inventory,complete.replace('--workspace @ubeeq/runtime','')),/omits public package: @ubeeq\/runtime/);
  assert.throws(()=>validatePublishSelection(inventory,complete+' --workspace @ubeeq/reference'),/private or unknown/);
 }finally{await rm(root,{recursive:true,force:true});}
});
