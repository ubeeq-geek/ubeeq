import { execFileSync } from "node:child_process";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required deployment configuration: ${name}`);
  return value;
};
const output = (region, stack, key) => execFileSync("aws", ["cloudformation", "describe-stacks", "--region", region, "--stack-name", stack, "--query", `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, "--output", "text"], { encoding: "utf8" }).trim();
const run = (workspace, env) => execFileSync("npm", ["run", "deploy", "--workspace", workspace, "--", "--require-approval", "never"], { stdio: "inherit", env: { ...process.env, ...env } });

const sourceRegion = required("UBEEQ_SOURCE_REGION");
const destinationRegion = required("UBEEQ_DESTINATION_REGION");
const controlRegion = required("UBEEQ_CONTROL_REGION");
const sourceStack = required("UBEEQ_SOURCE_STACK");
const destinationStack = required("UBEEQ_DESTINATION_STACK");
const controlStack = required("UBEEQ_CONTROL_STACK");
const operator = required("UBEEQ_MIGRATION_OPERATOR_PRINCIPAL_ARN");

run("@ubeeq/deployment-aws-serverless-multi-cell", {
  STACK_NAME: controlStack,
  UBEEQ_CONTROL_PLANE_REGION: controlRegion,
  UBEEQ_MIGRATION_OPERATOR_PRINCIPAL_ARN: operator,
});
const routingTable = output(controlRegion, controlStack, "RoutingDirectoryTableName");
const routingArn = output(controlRegion, controlStack, "RoutingDirectoryTableArn");
const workerRole = output(controlRegion, controlStack, "MigrationControlWorkerRoleArn");
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
  UBEEQ_RUNTIME_REVISION: process.env.CODEBUILD_RESOLVED_SOURCE_VERSION || "unversioned",
});
deployCell(sourceRegion, sourceStack, required("UBEEQ_SOURCE_CELL_ID"), required("UBEEQ_SOURCE_BASE_URL"));
deployCell(destinationRegion, destinationStack, required("UBEEQ_DESTINATION_CELL_ID"), required("UBEEQ_DESTINATION_BASE_URL"));
const sourceBucket = output(sourceRegion, sourceStack, "SourceStoreName");
const destinationBucket = output(destinationRegion, destinationStack, "SourceStoreName");
const sourceFunction = output(sourceRegion, sourceStack, "MigrationCellFunctionArn");
const destinationFunction = output(destinationRegion, destinationStack, "MigrationCellFunctionArn");
run("@ubeeq/deployment-aws-serverless-multi-cell", {
  STACK_NAME: controlStack,
  UBEEQ_CONTROL_PLANE_REGION: controlRegion,
  UBEEQ_MIGRATION_OPERATOR_PRINCIPAL_ARN: operator,
  UBEEQ_MIGRATION_BUCKET_ARNS: `arn:aws:s3:::${sourceBucket},arn:aws:s3:::${destinationBucket}`,
  UBEEQ_MIGRATION_FUNCTION_ARNS: `${sourceFunction},${destinationFunction}`,
});
