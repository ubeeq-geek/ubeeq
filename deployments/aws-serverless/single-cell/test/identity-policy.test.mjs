import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AwsServerlessSingleCellStack } from '../dist/lib/aws-serverless-single-cell-stack.js';

test('API and worker account-status permission is scoped to their configured user pool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'identity-policy-'));
  try {
    const asset = join(directory, 'lambda');
    const { mkdir } = await import('node:fs/promises'); await mkdir(asset);
    await writeFile(join(asset, 'lambda.js'), 'exports.handler=async()=>({statusCode:200});\n');
    const app = new App({ outdir: join(directory, 'cdk.out'), context: { referenceApiAssetPath: asset, cellId: 'test-cell', cellRegion: 'us-east-2' } });
    const stack = new AwsServerlessSingleCellStack(app, 'IdentityPolicyTest', { env: { account: '000000000000', region: 'us-east-2' } });
    const template = Template.fromStack(stack).toJSON();
    const pool = Object.entries(template.Resources).find(([,value]) => value.Type === 'AWS::Cognito::UserPool')[0];
    const grants = [];
    for (const resource of Object.values(template.Resources)) {
      if (resource.Type !== 'AWS::IAM::Policy') continue;
      for (const statement of resource.Properties.PolicyDocument.Statement) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        if (actions.includes('cognito-idp:AdminGetUser')) grants.push({ statement, roles: resource.Properties.Roles });
      }
    }
    assert.equal(grants.length, 2);
    for (const { statement, roles } of grants) {
      assert.equal(statement.Effect, 'Allow');
      assert.deepEqual(statement.Action, 'cognito-idp:AdminGetUser');
      assert.deepEqual(statement.Resource, { 'Fn::GetAtt': [pool, 'Arn'] });
      assert.equal(roles.length, 1);
      assert.match(roles[0].Ref, /Reference(Api|Worker)ServiceRole/);
    }
    assert.notDeepEqual(grants[0].roles, grants[1].roles);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
