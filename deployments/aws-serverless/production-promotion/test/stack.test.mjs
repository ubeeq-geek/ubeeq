import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{App}=require('aws-cdk-lib'),{Template}=require('aws-cdk-lib/assertions'),{AwsServerlessProductionPromotionStack}=require('../dist/lib/aws-serverless-production-promotion-stack.js');
test('production promotion requires configuration and approval before deployment, using only configured bootstrap roles',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'production-promotion-synth-')),previous=process.env.UBEEQ_GITHUB_CONNECTION_ARN;
 try{
  delete process.env.UBEEQ_GITHUB_CONNECTION_ARN;
  assert.throws(()=>new AwsServerlessProductionPromotionStack(new App({outdir:join(directory,'missing')}),'Missing',{env:{account:'111111111111',region:'us-east-2'}}),/githubConnectionArn/);
  const context={githubConnectionArn:'arn:aws:codestar-connections:us-east-2:111111111111:connection/00000000-0000-4000-8000-000000000000',sourceRegion:'us-east-2',destinationRegion:'eu-central-1',controlRegion:'us-east-2',sourceStack:'Source',destinationStack:'Destination',controlStack:'Control',sourceCellId:'source-cell',destinationCellId:'destination-cell',sourceBaseUrl:'https://source.example.invalid/',destinationBaseUrl:'https://destination.example.invalid/'};
  const stack=new AwsServerlessProductionPromotionStack(new App({outdir:join(directory,'out'),context}),'Promotion',{env:{account:'111111111111',region:'us-east-2'}}),resources=Object.values(Template.fromStack(stack).toJSON().Resources),pipeline=resources.find(r=>r.Type==='AWS::CodePipeline::Pipeline');
  assert.deepEqual(pipeline.Properties.Stages.map(s=>s.Name),['Source','Plan','ApproveProduction','Deploy']);
  assert.equal(pipeline.Properties.Stages[2].Actions[0].ActionTypeId.Provider,'Manual');
  assert.deepEqual(pipeline.Properties.Stages[1].Actions[0].InputArtifacts,pipeline.Properties.Stages[3].Actions[0].InputArtifacts,'Plan and approved deployment must consume the same source artifact');
  const tree=Template.fromStack(stack).toJSON().Resources,deployRole=Object.keys(tree).find(id=>id.startsWith('ProductionDeployBuildRole')&&tree[id].Type==='AWS::IAM::Role');
  assert.ok(deployRole);
  const grants=resources.filter(r=>r.Type==='AWS::IAM::Policy'&&r.Properties.Roles?.some(role=>role.Ref===deployRole)).flatMap(r=>r.Properties.PolicyDocument.Statement).filter(s=>(Array.isArray(s.Action)?s.Action:[s.Action]).includes('sts:AssumeRole')).flatMap(s=>Array.isArray(s.Resource)?s.Resource:[s.Resource]);
  const expected=['us-east-2','eu-central-1'].flatMap(region=>['deploy-role','file-publishing-role','lookup-role'].map(role=>'arn:aws:iam::111111111111:role/cdk-hnb659fds-'+role+'-111111111111-'+region));
  assert.deepEqual([...new Set(grants)].sort(),expected.sort());
 }finally{if(previous===undefined)delete process.env.UBEEQ_GITHUB_CONNECTION_ARN;else process.env.UBEEQ_GITHUB_CONNECTION_ARN=previous;await rm(directory,{recursive:true,force:true});}
});
