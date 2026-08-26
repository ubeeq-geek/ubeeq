import * as cdk from "aws-cdk-lib";
import { SelfHostReferenceStack } from "../lib/self-host-reference-stack";

const app = new cdk.App();
new SelfHostReferenceStack(app, app.node.tryGetContext("stackName") || process.env.STACK_NAME || "UbeeqSelfHostDev", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION || "us-east-2" }
});
