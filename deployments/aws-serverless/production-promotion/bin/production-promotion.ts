import * as cdk from "aws-cdk-lib";
import { AwsServerlessProductionPromotionStack } from "../lib/aws-serverless-production-promotion-stack";

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = app.node.tryGetContext("region") || process.env.UBEEQ_PIPELINE_REGION || process.env.CDK_DEFAULT_REGION;
if (!account || !region) throw new Error("Set AWS credentials and UBEEQ_PIPELINE_REGION (or CDK_DEFAULT_REGION) before deploying the promotion pipeline.");

new AwsServerlessProductionPromotionStack(app, app.node.tryGetContext("stackName") || process.env.STACK_NAME || "UbeeqProductionPromotion", {
  env: { account, region },
});
