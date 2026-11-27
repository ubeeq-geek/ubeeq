import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required deployment configuration: ${name}`);
  return value;
};
const stackOutputs = (region, stack, allowMissing = false) => {
  let response;
  try {
    response = execFileSync("aws", ["cloudformation", "describe-stacks", "--region", region, "--stack-name", stack, "--query", "Stacks[0].Outputs", "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const reason = error.stderr?.trim().split("\n").at(-1);
    if (allowMissing && reason === `An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stack} does not exist`) {
      return undefined;
    }
    throw error;
  }
  return Object.fromEntries((JSON.parse(response) ?? []).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
};
const output = (outputs, stack, key) => {
  if (!outputs[key]) throw new Error(`Stack ${stack} is missing required output ${key}.`);
  return outputs[key];
};
const runtime = process.env.UBEEQ_LAMBDA_RUNTIME;
if (runtime && runtime !== "rust" && runtime !== "node") {
  throw new Error("UBEEQ_LAMBDA_RUNTIME must be rust or node.");
}
const rustAssets = {};
for (const name of [
  "UBEEQ_RUST_MIGRATION_CONTROL_API_ASSET_PATH",
  "UBEEQ_RUST_MIGRATION_CONTROL_WORKER_ASSET_PATH",
  "UBEEQ_RUST_MIGRATION_CELL_ASSET_PATH",
  "UBEEQ_RUST_REFERENCE_API_ASSET_PATH",
  "UBEEQ_RUST_REFERENCE_WORKER_ASSET_PATH",
  "UBEEQ_RUST_WEB_ASSET_PATH",
]) {
  if (runtime === "node") {
    rustAssets[name] = "";
  } else if (runtime === "rust") {
    const path = resolve(required(name));
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Missing Rust Lambda archive for ${name}: ${path}`);
    }
    rustAssets[name] = path;
  }
}
const run = (workspace, env) => {
  const command = runtime === "rust"
    ? ["exec", "--workspace", workspace, "--", "cdk", "deploy", "--require-approval", "never"]
    : ["run", "deploy", "--workspace", workspace, "--", "--require-approval", "never"];
  execFileSync("npm", command, { stdio: "inherit", env: { ...process.env, ...rustAssets, ...env } });
};

const sourceRegion = required("UBEEQ_SOURCE_REGION");
const destinationRegion = required("UBEEQ_DESTINATION_REGION");
const controlRegion = required("UBEEQ_CONTROL_REGION");
const sourceStack = required("UBEEQ_SOURCE_STACK");
const destinationStack = required("UBEEQ_DESTINATION_STACK");
const controlStack = required("UBEEQ_CONTROL_STACK");
const operator = required("UBEEQ_MIGRATION_OPERATOR_PRINCIPAL_ARN");
const sourceCellId = required("UBEEQ_SOURCE_CELL_ID");
const destinationCellId = required("UBEEQ_DESTINATION_CELL_ID");

// The control plane and cells share the reference API Lambda asset. Package it
// before the first CDK synthesis so the control-plane deployment can stage it.
if (runtime !== "rust") {
  execFileSync("npm", ["run", "package:lambda", "--workspace", "@ubeeq/reference-api"], { stdio: "inherit", env: process.env });
}

const controlEnvironment = {
  STACK_NAME: controlStack,
  UBEEQ_CONTROL_PLANE_REGION: controlRegion,
  UBEEQ_MIGRATION_OPERATOR_PRINCIPAL_ARN: operator,
};
// Existing control planes keep their cell permissions until the final deployment.
let control = stackOutputs(controlRegion, controlStack, true);
if (!control) {
  run("@ubeeq/deployment-aws-serverless-multi-cell", controlEnvironment);
  control = stackOutputs(controlRegion, controlStack);
}
const routingTable = output(control, controlStack, "RoutingDirectoryTableName");
const routingArn = output(control, controlStack, "RoutingDirectoryTableArn");
const workerRole = output(control, controlStack, "MigrationControlWorkerRoleArn");
const deployCell = (region, stack, cellId, baseUrl) => run("@ubeeq/deployment-aws-serverless-single-cell", {
  STACK_NAME: stack,
  UBEEQ_DEPLOYMENT_REGION: region,
  UBEEQ_CELL_REGION: region,
  UBEEQ_CELL_ID: cellId,
  UBEEQ_REFERENCE_API_PUBLIC_BASE_URL: baseUrl,
  UBEEQ_ROUTING_DIRECTORY_TABLE_NAME: routingTable,
  UBEEQ_ROUTING_DIRECTORY_TABLE_ARN: routingArn,
  UBEEQ_ROUTING_DIRECTORY_REGION: controlRegion,
  UBEEQ_MIGRATION_CONTROL_WORKER_PRINCIPAL_ARN: workerRole,
  UBEEQ_RUNTIME_REVISION: process.env.CODEBUILD_RESOLVED_SOURCE_VERSION || process.env.GITHUB_SHA || "unversioned",
});
deployCell(sourceRegion, sourceStack, sourceCellId, process.env.UBEEQ_SOURCE_BASE_URL || "");
deployCell(destinationRegion, destinationStack, destinationCellId, process.env.UBEEQ_DESTINATION_BASE_URL || "");
const source = stackOutputs(sourceRegion, sourceStack);
const destination = stackOutputs(destinationRegion, destinationStack);
const sourceBucket = output(source, sourceStack, "SourceStoreName");
const destinationBucket = output(destination, destinationStack, "SourceStoreName");
const sourceFunction = output(source, sourceStack, "MigrationCellFunctionArn");
const destinationFunction = output(destination, destinationStack, "MigrationCellFunctionArn");
run("@ubeeq/deployment-aws-serverless-multi-cell", {
  ...controlEnvironment,
  UBEEQ_MIGRATION_BUCKET_ARNS: `arn:aws:s3:::${sourceBucket},arn:aws:s3:::${destinationBucket}`,
  UBEEQ_MIGRATION_FUNCTION_ARNS: `${sourceFunction},${destinationFunction}`,
});
