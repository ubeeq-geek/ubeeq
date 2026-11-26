import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{App}=require('aws-cdk-lib'),{Template}=require('aws-cdk-lib/assertions'),{AwsServerlessMultiCellStack}=require('../dist/lib/aws-serverless-multi-cell-stack.js');
test('multi-cell control preserves recovery state, requires IAM and confines migration authority to configured resources',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'multi-cell-synth-'));
 try{
  const asset=join(directory,'asset');await mkdir(asset);await writeFile(join(asset,'lambda.js'),'exports.migrationControlApi=async()=>({statusCode:503});exports.migrationControlWorker=async()=>{};');
  const buckets=['arn:aws:s3:::owned-source','arn:aws:s3:::owned-destination'],functions=['arn:aws:lambda:us-east-2:111111111111:function:owned-source','arn:aws:lambda:eu-central-1:111111111111:function:owned-destination'],principal='arn:aws:iam::111111111111:role/owned-operator';
  const app=new App({outdir:join(directory,'out'),context:{referenceApiAssetPath:asset,migrationBucketArns:buckets.join(','),migrationFunctionArns:functions.join(','),migrationOperatorPrincipalArn:principal}});
  const stack=new AwsServerlessMultiCellStack(app,'Control',{env:{account:'111111111111',region:'us-east-2'}}),template=Template.fromStack(stack);
  template.resourceCountIs('AWS::Lambda::Function',2);template.resourceCountIs('AWS::CloudWatch::Alarm',3);template.resourceCountIs('AWS::CloudWatch::Dashboard',1);
  template.hasResourceProperties('AWS::Lambda::Url',{AuthType:'AWS_IAM'});
  template.hasResourceProperties('AWS::SQS::Queue',{VisibilityTimeout:900});
  template.hasResourceProperties('AWS::Lambda::Function',{Handler:'lambda.migrationControlWorker',Timeout:840});
  const resources=Object.values(template.toJSON().Resources),table=resources.find(r=>r.Type==='AWS::DynamoDB::Table');
  assert.equal(table.DeletionPolicy,'Retain');assert.equal(table.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled,true);
  const api=resources.find(r=>r.Type==='AWS::Lambda::Function'&&r.Properties.Handler==='lambda.migrationControlApi');assert.equal(api.Properties.Environment.Variables.UBEEQ_MIGRATION_OPERATOR_PRINCIPAL_ARN,principal);
  const statements=resources.filter(r=>r.Type==='AWS::IAM::Policy').flatMap(r=>r.Properties.PolicyDocument.Statement);
  for(const [prefix,expected] of [['s3:',buckets.map(x=>x+'/*')],['lambda:InvokeFunction',functions]]){
   const granted=statements.filter(s=>(Array.isArray(s.Action)?s.Action:[s.Action]).some(a=>a.startsWith(prefix))).flatMap(s=>Array.isArray(s.Resource)?s.Resource:[s.Resource]);
   assert.deepEqual([...new Set(granted)].sort(),[...expected].sort());
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('the Rust operator API uses its own asset and keeps the IAM Function URL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'migration-api-rust-'));
  try {
    const referenceAsset = join(directory, 'node');
    const rustAsset = join(directory, 'rust');
    await mkdir(referenceAsset);
    await mkdir(rustAsset);
    await writeFile(join(referenceAsset, 'lambda.js'), 'synthetic worker asset');
    await writeFile(join(rustAsset, 'bootstrap'), 'synthetic operator API asset');
    const app = new App({ outdir: join(directory, 'out'), context: {
      referenceApiAssetPath: referenceAsset,
      rustMigrationControlApiAssetPath: rustAsset,
    } });
    const stack = new AwsServerlessMultiCellStack(app, 'RustControl', {
      env: { account: '111111111111', region: 'us-east-2' },
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'bootstrap', Runtime: 'provided.al2023' });
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'lambda.migrationControlWorker', Runtime: 'nodejs22.x' });
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the native migration worker keeps partial SQS retries and allocates transfer storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'migration-worker-rust-'));
  try {
    const referenceAsset = join(directory, 'node');
    const rustAsset = join(directory, 'rust');
    await mkdir(referenceAsset);
    await mkdir(rustAsset);
    await writeFile(join(referenceAsset, 'lambda.js'), 'synthetic API asset');
    await writeFile(join(rustAsset, 'bootstrap'), 'synthetic worker asset');
    const app = new App({ outdir: join(directory, 'out'), context: {
      referenceApiAssetPath: referenceAsset,
      rustMigrationControlWorkerAssetPath: rustAsset,
    } });
    const stack = new AwsServerlessMultiCellStack(app, 'RustWorker', {
      env: { account: '111111111111', region: 'us-east-2' },
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'bootstrap', Runtime: 'provided.al2023', Timeout: 840,
      EphemeralStorage: { Size: 6144 },
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
