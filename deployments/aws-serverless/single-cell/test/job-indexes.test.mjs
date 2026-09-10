import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsServerlessSingleCellStack } from "../dist/lib/aws-serverless-single-cell-stack.js";

const synth = (context = {}) => {
  const outdir = mkdtempSync(join(tmpdir(), "ubeeq-job-index-test-"));
  try {
    const app = new App({ outdir, context: { cellId: "test-cell", referenceApiAssetPath: dirname(fileURLToPath(import.meta.url)), ...context } });
    const stack = new AwsServerlessSingleCellStack(app, "TestCell", { env: { account: "123456789012", region: "us-east-2" } });
    return Template.fromStack(stack).toJSON();
  } finally { rmSync(outdir, { recursive: true, force: true }); }
};
const tableEntry = template => Object.entries(template.Resources).find(([, resource]) => resource.Type === "AWS::DynamoDB::Table");
const indexes = template => tableEntry(template)[1].Properties.GlobalSecondaryIndexes;
const functions = template => Object.values(template.Resources).filter(resource => resource.Type === "AWS::Lambda::Function");

test("default provisioning preserves the legacy table and omits runtime opt-in", () => {
  const template = synth();
  assert.deepEqual(indexes(template).map(index => index.IndexName), ["repository-id-index"]);
  for (const fn of functions(template)) assert.equal(fn.Properties.Environment.Variables.UBEEQ_JOB_DISCOVERY_QUALIFIED, undefined);
  const table = tableEntry(template)[1];
  assert.equal(table.DeletionPolicy, "Retain");
  assert.equal(table.Properties.BillingMode, "PAY_PER_REQUEST");
});

test("each provisioning stage adds exactly one sparse index without changing other resources", () => {
  const templates = ["none", "cell", "both"].map(jobDiscoveryIndexStage => synth({ jobDiscoveryIndexStage }));
  for (let i = 1; i < templates.length; i++) {
    assert.equal(indexes(templates[i]).length, indexes(templates[i - 1]).length + 1);
    assert.deepEqual(indexes(templates[i]).slice(0, i), indexes(templates[i - 1]));
    assert.equal(tableEntry(templates[i])[0], tableEntry(templates[i - 1])[0]);
    const withoutTable = template => Object.fromEntries(Object.entries(template.Resources).filter(([id]) => id !== tableEntry(template)[0]));
    assert.deepEqual(withoutTable(templates[i]), withoutTable(templates[i - 1]));
  }
  const table = tableEntry(templates[2])[1].Properties;
  for (const [indexName, partition] of [["job-cell-due-index", "jobCell"], ["job-cell-type-due-index", "jobCellType"]]) {
    assert.deepEqual(table.GlobalSecondaryIndexes.find(index => index.IndexName === indexName), {
      IndexName: indexName, KeySchema: [{ AttributeName: partition, KeyType: "HASH" }, { AttributeName: "jobDue", KeyType: "RANGE" }], Projection: { ProjectionType: "KEYS_ONLY" },
    });
    assert.ok(table.AttributeDefinitions.some(attribute => attribute.AttributeName === partition && attribute.AttributeType === "S"));
  }
  assert.ok(table.AttributeDefinitions.some(attribute => attribute.AttributeName === "jobDue" && attribute.AttributeType === "N"));
});

test("qualification changes runtime settings only and excludes the web runtime", () => {
  const before = synth({ jobDiscoveryIndexStage: "both" });
  const after = synth({ jobDiscoveryIndexStage: "both", jobDiscoveryQualified: "true" });
  assert.deepEqual(tableEntry(after), tableEntry(before));
  let configured = 0;
  for (const fn of functions(after)) {
    const env = fn.Properties.Environment.Variables;
    if (fn.Properties.Handler === "lambda.web") assert.equal(env.UBEEQ_JOB_DISCOVERY_QUALIFIED, undefined);
    else {
      assert.equal(env.UBEEQ_JOB_CELL_DUE_INDEX, "job-cell-due-index");
      assert.equal(env.UBEEQ_JOB_CELL_TYPE_DUE_INDEX, "job-cell-type-due-index");
      assert.equal(env.UBEEQ_JOB_DISCOVERY_QUALIFIED, "true");
      configured++;
    }
  }
  assert.equal(configured, 3);
  const stripped = structuredClone(after);
  for (const fn of functions(stripped)) {
    for (const key of ["UBEEQ_JOB_CELL_DUE_INDEX", "UBEEQ_JOB_CELL_TYPE_DUE_INDEX", "UBEEQ_JOB_DISCOVERY_QUALIFIED"]) delete fn.Properties.Environment.Variables[key];
  }
  assert.deepEqual(stripped, before);
});

test("invalid stages and premature qualification fail synthesis", () => {
  for (const jobDiscoveryIndexStage of ["", "all", true, 2]) assert.throws(() => synth({ jobDiscoveryIndexStage }), /must be none, cell or both/);
  for (const jobDiscoveryQualified of [true, "", "TRUE", "1"]) assert.throws(() => synth({ jobDiscoveryQualified }), /must be the string/);
  for (const jobDiscoveryIndexStage of ["none", "cell"]) assert.throws(() => synth({ jobDiscoveryIndexStage, jobDiscoveryQualified: "true" }), /requires both/);
  assert.deepEqual(synth({ jobDiscoveryIndexStage: "both", jobDiscoveryQualified: "false" }), synth({ jobDiscoveryIndexStage: "both" }));
});
