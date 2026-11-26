import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {hashDeploymentArtifactDirectory, validateDeploymentArtifactManifest} from '../dist/index.js';
const expected={product:'example',revision:'a'.repeat(40),artifacts:['api'],appCode:'EX',coreCommit:'b'.repeat(40),commercialCommit:'c'.repeat(40)};
const manifest={...expected,schemaVersion:2,migrationReady:false,artifacts:{api:{path:'bundle/api',fileCount:1,sha256:'d'.repeat(64)}}};
test('v2 binds source provenance, components and readiness while retaining v1',()=>{
 assert.equal(validateDeploymentArtifactManifest(manifest,expected),manifest);
 for(const key of ['product','revision','appCode','coreCommit','commercialCommit']) assert.throws(()=>validateDeploymentArtifactManifest({...manifest,[key]:'wrong'},expected));
 assert.throws(()=>validateDeploymentArtifactManifest(manifest,{...expected,requireMigrationReady:true}));
 for(const path of ['../escape','/absolute','x/../../escape','x\\escape','x/./y','x//y']) assert.throws(()=>validateDeploymentArtifactManifest({...manifest,artifacts:{api:{...manifest.artifacts.api,path}}},expected));
 assert.throws(()=>validateDeploymentArtifactManifest({...manifest,artifacts:{...manifest.artifacts,web:manifest.artifacts.api}},expected));
 const v1={schemaVersion:1,product:expected.product,revision:expected.revision,artifacts:manifest.artifacts};
 assert.equal(validateDeploymentArtifactManifest(v1,{product:expected.product,revision:expected.revision,artifacts:['api']}),v1);
 assert.throws(()=>validateDeploymentArtifactManifest(v1,expected));
});
test('digest versions have stable byte vectors and reject links and changed files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'artifact-contract-'));
 try{
  await mkdir(join(root,'nested'));await writeFile(join(root,'z'),'last');await writeFile(join(root,'nested','a'),'first');
  const legacy=createHash('sha256').update('nested/afirstzlast').digest('hex');
  const framed=createHash('sha256').update('nested/a\0first\0z\0last\0').digest('hex');
  assert.deepEqual(await hashDeploymentArtifactDirectory(root,1),{fileCount:2,sha256:legacy});
  assert.deepEqual(await hashDeploymentArtifactDirectory(root,2),{fileCount:2,sha256:framed});
  await writeFile(join(root,'z'),'changed');assert.notEqual((await hashDeploymentArtifactDirectory(root,2)).sha256,framed);
  await symlink(join(root,'z'),join(root,'link'));await assert.rejects(hashDeploymentArtifactDirectory(root,2),/regular files/);
 }finally{await rm(root,{recursive:true,force:true});}
});
