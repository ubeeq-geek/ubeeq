import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
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
 const v1={schemaVersion:1,product:expected.product,revision:'release-2026.11',artifacts:manifest.artifacts};
 assert.equal(validateDeploymentArtifactManifest(v1,{product:expected.product,revision:v1.revision,artifacts:['api']}),v1);
 assert.throws(()=>validateDeploymentArtifactManifest(v1,expected));
 const v3={...manifest,schemaVersion:3};
 assert.equal(validateDeploymentArtifactManifest(v3,{...expected,schemaVersion:3}),v3);
 assert.throws(()=>validateDeploymentArtifactManifest(manifest,{...expected,schemaVersion:3}),/identity/);
 assert.throws(()=>validateDeploymentArtifactManifest({...v3,revision:v1.revision},{...expected,revision:v1.revision}),/identity/);
});

test('schema 3 staged artifact matches the producer manifest across a copy', async () => {
 const root = await mkdtemp(join(tmpdir(), 'artifact-stage-v3-'));
 try {
  const producer = join(root, 'producer');
  const staging = join(root, 'staging');
  await mkdir(producer);
  await writeFile(join(producer, 'replacement-\uFFFD.bin'), Buffer.from([0, 255, 0]));
  const artifact = {path: 'api', ...await hashDeploymentArtifactDirectory(producer, 3)};
  const produced = {...manifest, schemaVersion: 3, migrationReady: true, artifacts: {api: artifact}};
  const plan = {...expected, schemaVersion: 3, requireMigrationReady: true};
  const reviewed = validateDeploymentArtifactManifest(JSON.parse(JSON.stringify(produced)), plan);
  await cp(producer, staging, {recursive: true});
  const staged = await hashDeploymentArtifactDirectory(staging, reviewed.schemaVersion);
  assert.deepEqual(staged, {fileCount: artifact.fileCount, sha256: artifact.sha256});
  await writeFile(join(staging, 'replacement-\uFFFD.bin'), Buffer.from([0, 254, 0]));
  assert.notEqual((await hashDeploymentArtifactDirectory(staging, 3)).sha256, artifact.sha256);
 } finally {
  await rm(root, {recursive: true, force: true});
 }
});

test('schema 3 has a stable digest for empty and binary files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'artifact-contract-v3-'));
 try{
  await writeFile(join(root,'a'),Buffer.from([0,255]));
  await writeFile(join(root,'b'),Buffer.alloc(0));
  const framed=Buffer.from('000000000000000161000000000000000200ff0000000000000001620000000000000000','hex');
  const sha256=createHash('sha256').update('ubeeq-deployment-artifact-v3\0').update(framed).digest('hex');
  assert.deepEqual(await hashDeploymentArtifactDirectory(root,3),{fileCount:2,sha256});
 }finally{await rm(root,{recursive:true,force:true});}
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
