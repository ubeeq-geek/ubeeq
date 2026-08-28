import * as cdk from "aws-cdk-lib";
import { AwsServerlessMultiCellStack } from "../lib/aws-serverless-multi-cell-stack";

const app = new cdk.App();
new AwsServerlessMultiCellStack(app, app.node.tryGetContext("stackName") || process.env.STACK_NAME || "UbeeqAwsServerlessMultiCell", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: app.node.tryGetContext("controlPlaneRegion") || process.env.UBEEQ_CONTROL_PLANE_REGION || process.env.CDK_DEFAULT_REGION || "us-east-2" }
});
