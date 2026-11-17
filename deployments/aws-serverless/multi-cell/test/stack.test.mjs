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
