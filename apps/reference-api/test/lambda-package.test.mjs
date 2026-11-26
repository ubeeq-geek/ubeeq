import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),root=fileURLToPath(new URL('../../..',import.meta.url));
test('isolated Lambda artifact imports and routes without checkout dependencies; missing JWT verification fails before deployment',{timeout:120000},async()=>{
 await run(process.execPath,[join(root,'scripts/package-reference-api-lambda.mjs')],{cwd:root,maxBuffer:100000});
 const directory=await mkdtemp(join(tmpdir(),'reference-lambda-isolated-'));
 try{
  await cp(join(root,'apps/reference-api/lambda-package'),directory,{recursive:true});
  const dependencies=JSON.parse(await readFile(join(directory,'runtime-dependencies.json'),'utf8'));
  assert.ok(dependencies.some(item=>item.name==='aws-jwt-verify'));
  const code=`import http from 'node:http';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';
http.request=https.request=()=>{throw Error('Isolated Lambda verification forbids network access');};syncBuiltinESMExports();globalThis.fetch=async()=>{throw Error('Isolated Lambda verification forbids network access');};
const module=await import(${JSON.stringify(pathToFileURL(join(directory,'lambda.js')).href)});
for(const [rawPath,status] of [['/health',200],['/__missing_route',404],['/v1/creators',401]]){const response=await module.handler({rawPath,headers:{},requestContext:{http:{method:'GET'}}});if(response.statusCode!==status)throw Error(rawPath+' returned '+response.statusCode);}
const response=await module.worker({Records:[]});if(response.batchItemFailures.length!==0)throw Error('Empty worker batch was not handled');`;
  const env={PATH:process.env.PATH,NODE_ENV:'test',AWS_REGION:'us-east-2',AWS_EC2_METADATA_DISABLED:'true',AWS_CONFIG_FILE:join(directory,'absent-config'),AWS_SHARED_CREDENTIALS_FILE:join(directory,'absent-credentials'),UBEEQ_PUBLIC_BASE_URL:'https://artifact.test',UBEEQ_RECORDS_TABLE:'artifact-records',UBEEQ_SOURCE_BUCKET:'artifact-originals',UBEEQ_JOBS_QUEUE_URL:'https://sqs.us-east-2.amazonaws.com/000000000000/artifact',UBEEQ_USER_POOL_ID:'us-east-2_Artifact',UBEEQ_USER_POOL_CLIENT_ID:'artifact',UBEEQ_CREDENTIAL_SECRET_PREFIX:'artifact/credentials'};
  await run(process.execPath,['--input-type=module','-e',code],{cwd:directory,env,timeout:30000,maxBuffer:100000});
  const jwt=dependencies.find(item=>item.name==='aws-jwt-verify');await rm(resolve(directory,jwt.path),{recursive:true,force:true});
  await assert.rejects(run(process.execPath,['--input-type=module','-e',code],{cwd:directory,env,timeout:30000,maxBuffer:100000}),/Cannot find module 'aws-jwt-verify'/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
