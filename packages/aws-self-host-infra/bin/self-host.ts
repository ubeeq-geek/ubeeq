import * as cdk from "aws-cdk-lib";
import { SelfHostReferenceStack } from "../lib/self-host-reference-stack";
import { RegionalControlPlaneStack } from "../lib/regional-control-plane-stack";

const app = new cdk.App();
new SelfHostReferenceStack(app, app.node.tryGetContext("stackName") || process.env.STACK_NAME || "UbeeqSelfHostDev", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION || "us-east-2" }
});

const controlPlaneStackName = app.node.tryGetContext("controlPlaneStackName") || process.env.UBEEQ_CONTROL_PLANE_STACK_NAME;
if (controlPlaneStackName) new RegionalControlPlaneStack(app, controlPlaneStackName, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: app.node.tryGetContext("controlPlaneRegion") || process.env.UBEEQ_CONTROL_PLANE_REGION || process.env.CDK_DEFAULT_REGION || "us-east-2" }
});
