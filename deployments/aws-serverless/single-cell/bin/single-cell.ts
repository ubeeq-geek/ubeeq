import * as cdk from "aws-cdk-lib";
import { AwsServerlessSingleCellStack } from "../lib/aws-serverless-single-cell-stack";

const app = new cdk.App();
const deploymentRegion = app.node.tryGetContext("deploymentRegion") || process.env.UBEEQ_DEPLOYMENT_REGION || process.env.CDK_DEFAULT_REGION;
if (!deploymentRegion) throw new Error("Set deploymentRegion context or UBEEQ_DEPLOYMENT_REGION explicitly; do not rely on an AWS profile default region for a regional cell.");
new AwsServerlessSingleCellStack(app, app.node.tryGetContext("stackName") || process.env.STACK_NAME || "UbeeqAwsServerlessSingleCell", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: deploymentRegion }
});
