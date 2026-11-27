import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AwsServerlessSingleCellStack } from '../dist/lib/aws-serverless-single-cell-stack.js';

test('API and worker account-status and group permissions are scoped to their configured user pool', async () => {
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
      assert.deepEqual([...statement.Action].sort(), ['cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser']);
      assert.deepEqual(statement.Resource, { 'Fn::GetAtt': [pool, 'Arn'] });
      assert.equal(roles.length, 1);
      assert.match(roles[0].Ref, /Reference(Api|Worker)ServiceRole/);
    }
    assert.notDeepEqual(grants[0].roles, grants[1].roles);
    const api = Object.values(template.Resources).find(value => value.Type === 'AWS::Lambda::Function' && value.Properties.Handler === 'lambda.handler');
    assert.equal(api.Properties.Environment.Variables.UBEEQ_PASSWORD_AUTH_ENABLED, 'true');
    const appClient = Object.values(template.Resources).find(value => value.Type === 'AWS::Cognito::UserPoolClient');
    assert.ok(appClient.Properties.ExplicitAuthFlows.includes('ALLOW_USER_PASSWORD_AUTH'));
    assert.notEqual(appClient.Properties.GenerateSecret, true);
    assert.equal(template.Resources[pool].Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the reference web function can use its own Rust bootstrap asset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reference-web-rust-'));
  try {
    const { mkdir } = await import('node:fs/promises');
    const api = join(directory, 'api');
    const web = join(directory, 'web');
    await mkdir(api);
    await mkdir(web);
    await writeFile(join(api, 'lambda.js'), 'exports.handler=async()=>({statusCode:200});\n');
    await writeFile(join(web, 'bootstrap'), 'synthetic Rust asset');
    const app = new App({ outdir: join(directory, 'cdk.out'), context: { referenceApiAssetPath: api, rustWebAssetPath: web } });
    const stack = new AwsServerlessSingleCellStack(app, 'RustWebTest', { env: { account: '000000000000', region: 'us-east-2' } });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'bootstrap', Runtime: 'provided.al2023' });
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'lambda.handler', Runtime: 'nodejs22.x' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the Rust migration cell gets only point reads on the control directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'migration-cell-rust-'));
  try {
    const { mkdir } = await import('node:fs/promises');
    const api = join(directory, 'api');
    const cell = join(directory, 'cell');
    await mkdir(api);
    await mkdir(cell);
    await writeFile(join(api, 'lambda.js'), 'synthetic API asset');
    await writeFile(join(cell, 'bootstrap'), 'synthetic migration cell asset');
    const routingArn = 'arn:aws:dynamodb:us-east-2:111111111111:table/control-directory';
    const app = new App({ outdir: join(directory, 'out'), context: {
      referenceApiAssetPath: api, rustMigrationCellAssetPath: cell,
      routingDirectoryTableArn: routingArn, routingDirectoryTableName: 'control-directory',
      routingDirectoryRegion: 'us-east-2',
      migrationControlWorkerPrincipalArn: 'arn:aws:iam::111111111111:role/migration-worker',
    } });
    const stack = new AwsServerlessSingleCellStack(app, 'RustMigrationCell', {
      env: { account: '111111111111', region: 'eu-central-1' },
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'bootstrap', Runtime: 'provided.al2023' });
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction', Principal: 'arn:aws:iam::111111111111:role/migration-worker',
    });
    const resources = Object.values(template.toJSON().Resources);
    const role = resources.filter(value => value.Type === 'AWS::IAM::Policy')
      .find(value => value.Properties.Roles.some(role => role.Ref?.startsWith('MigrationCellServiceRole')));
    const directoryGrants = role.Properties.PolicyDocument.Statement.filter(statement => statement.Resource === routingArn);
    assert.deepEqual(directoryGrants, [{ Action: 'dynamodb:GetItem', Effect: 'Allow', Resource: routingArn }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the Rust reference worker retains the SQS trigger and runtime configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reference-worker-rust-'));
  try {
    const { mkdir } = await import('node:fs/promises');
    const api = join(directory, 'api');
    const worker = join(directory, 'worker');
    await mkdir(api);
    await mkdir(worker);
    await writeFile(join(api, 'lambda.js'), 'synthetic Node asset');
    await writeFile(join(worker, 'bootstrap'), 'synthetic Rust asset');
    const app = new App({ outdir: join(directory, 'out'), context: {
      referenceApiAssetPath: api, rustReferenceWorkerAssetPath: worker,
    } });
    const stack = new AwsServerlessSingleCellStack(app, 'RustReferenceWorker', {
      env: { account: '111111111111', region: 'us-east-2' },
    });
    const resources = Template.fromStack(stack).toJSON().Resources;
    const [workerId, workerResource] = Object.entries(resources)
      .find(([id, resource]) => id.startsWith('ReferenceWorker') && resource.Type === 'AWS::Lambda::Function');
    assert.equal(workerResource.Properties.Runtime, 'provided.al2023');
    assert.equal(workerResource.Properties.Handler, 'bootstrap');
    assert.equal(workerResource.Properties.Timeout, 120);
    for (const name of ['UBEEQ_RECORDS_TABLE', 'UBEEQ_SOURCE_BUCKET', 'UBEEQ_CELL_ID']) {
      assert.ok(workerResource.Properties.Environment.Variables[name]);
    }
    const trigger = Object.values(resources).find(resource => resource.Type === 'AWS::Lambda::EventSourceMapping');
    assert.deepEqual(trigger.Properties.FunctionName, { Ref: workerId });
    assert.deepEqual(trigger.Properties.FunctionResponseTypes, ['ReportBatchItemFailures']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the Rust reference API retains its HTTP integrations and Cognito configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reference-api-rust-'));
  try {
    const { mkdir } = await import('node:fs/promises');
    const node = join(directory, 'node');
    const rust = join(directory, 'rust');
    await mkdir(node);
    await mkdir(rust);
    await writeFile(join(node, 'lambda.js'), 'synthetic Node asset');
    await writeFile(join(rust, 'bootstrap'), 'synthetic Rust asset');
    const app = new App({ outdir: join(directory, 'out'), context: {
      referenceApiAssetPath: node, rustReferenceApiAssetPath: rust,
    } });
    const stack = new AwsServerlessSingleCellStack(app, 'RustReferenceApi', {
      env: { account: '111111111111', region: 'us-east-2' },
    });
    const resources = Template.fromStack(stack).toJSON().Resources;
    const [apiId, api] = Object.entries(resources)
      .find(([id, resource]) => id.startsWith('ReferenceApi') && resource.Type === 'AWS::Lambda::Function');
    assert.equal(api.Properties.Runtime, 'provided.al2023');
    assert.equal(api.Properties.Handler, 'bootstrap');
    assert.equal(api.Properties.Environment.Variables.UBEEQ_PASSWORD_AUTH_ENABLED, 'true');
    assert.ok(api.Properties.Environment.Variables.UBEEQ_USER_POOL_ID);
    assert.ok(api.Properties.Environment.Variables.UBEEQ_PUBLIC_BASE_URL);
    const apiArn = { 'Fn::GetAtt': [apiId, 'Arn'] };
    const integrations = Object.values(resources).filter(resource => resource.Type === 'AWS::ApiGatewayV2::Integration');
    assert.equal(integrations.filter(resource => JSON.stringify(resource.Properties.IntegrationUri) === JSON.stringify(apiArn)).length, 2);
    const functionUrl = Object.values(resources).find(resource => resource.Type === 'AWS::Lambda::Url');
    assert.deepEqual(functionUrl.Properties.TargetFunctionArn, apiArn);
    assert.equal(functionUrl.Properties.AuthType, 'AWS_IAM');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
