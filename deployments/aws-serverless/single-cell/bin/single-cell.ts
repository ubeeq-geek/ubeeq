import * as cdk from "aws-cdk-lib";
import { AwsServerlessSingleCellStack } from "../lib/aws-serverless-single-cell-stack";

const app = new cdk.App();
new AwsServerlessSingleCellStack(app, app.node.tryGetContext("stackName") || process.env.STACK_NAME || "UbeeqAwsServerlessSingleCell", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION || "us-east-2" }
});
