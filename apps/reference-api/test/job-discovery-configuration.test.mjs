import assert from "node:assert/strict";
import test from "node:test";
import { jobDiscoveryConfiguration } from "../dist/job-discovery-configuration.js";
import { handler, migrationCell } from "../dist/lambda.js";

const enabled = {
  UBEEQ_JOB_CELL_DUE_INDEX: "job-cell-due-index",
  UBEEQ_JOB_CELL_TYPE_DUE_INDEX: "job-cell-type-due-index",
  UBEEQ_JOB_DISCOVERY_QUALIFIED: "true",
};

test("absent settings retain legacy discovery without mutating the environment", () => {
  assert.deepEqual(jobDiscoveryConfiguration(Object.freeze({ AWS_REGION: "us-east-2" })), {});
});

test("qualified configuration returns an independent index-name snapshot", () => {
  const environment = { ...enabled };
  const configuration = jobDiscoveryConfiguration(environment);
  environment.UBEEQ_JOB_CELL_DUE_INDEX = "changed-index";
  assert.deepEqual(configuration, { jobDiscoveryIndexes: { cellDue: enabled.UBEEQ_JOB_CELL_DUE_INDEX, cellTypeDue: enabled.UBEEQ_JOB_CELL_TYPE_DUE_INDEX } });
});

test("every partial configuration fails closed", () => {
  const entries = Object.entries(enabled);
  for (let mask = 1; mask < 7; mask++) {
    assert.throws(() => jobDiscoveryConfiguration(Object.fromEntries(entries.filter((_, i) => mask & (1 << i)))), /requires distinct valid/);
  }
});

test("qualification is an exact explicit assertion", () => {
  for (const value of ["", "false", "TRUE", "1", " true "]) {
    assert.throws(() => jobDiscoveryConfiguration({ ...enabled, UBEEQ_JOB_DISCOVERY_QUALIFIED: value }), /after table qualification/);
  }
});

test("invalid and identical names cannot silently select legacy discovery", () => {
  for (const key of ["UBEEQ_JOB_CELL_DUE_INDEX", "UBEEQ_JOB_CELL_TYPE_DUE_INDEX"]) {
    for (const value of ["", "ab", " leading", "slash/name", "x".repeat(256)]) {
      assert.throws(() => jobDiscoveryConfiguration({ ...enabled, [key]: value }), /requires distinct valid/);
    }
  }
  assert.throws(() => jobDiscoveryConfiguration({ ...enabled, UBEEQ_JOB_CELL_DUE_INDEX: enabled.UBEEQ_JOB_CELL_TYPE_DUE_INDEX }), /requires distinct valid/);
});

test("both Lambda compositions reject partial settings before dependency access", async () => {
  const settings = {
    UBEEQ_PUBLIC_BASE_URL: "https://reference.example",
    UBEEQ_RECORDS_TABLE: "records",
    UBEEQ_SOURCE_BUCKET: "objects",
    UBEEQ_JOBS_QUEUE_URL: "https://sqs.example/jobs",
    UBEEQ_USER_POOL_ID: "pool",
    UBEEQ_USER_POOL_CLIENT_ID: "client",
    UBEEQ_CREDENTIAL_SECRET_PREFIX: "ubeeq/test",
    ...enabled,
  };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, settings);
    delete process.env.UBEEQ_JOB_DISCOVERY_QUALIFIED;
    const response = await handler({ rawPath: "/health" });
    assert.equal(response.statusCode, 503);
    assert.match(JSON.parse(response.body).error.message, /after table qualification/);
    const migration = await migrationCell({});
    assert.match(migration.error?.message ?? "", /after table qualification/);
    process.env.UBEEQ_JOB_DISCOVERY_QUALIFIED = "true";
    const healthy = await handler({ rawPath: "/health" });
    assert.equal(healthy.statusCode, 200);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
