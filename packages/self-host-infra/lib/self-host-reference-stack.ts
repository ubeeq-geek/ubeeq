import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

/** Neutral, self-hostable foundation; product domains, policy, and credentials are intentionally absent. */
export class SelfHostReferenceStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const bucketProps = { blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true, versioned: true, removalPolicy: RemovalPolicy.RETAIN, autoDeleteObjects: false };
    const sourceStore = new s3.Bucket(this, "SourceStore", bucketProps);
    const deliveryStore = new s3.Bucket(this, "DeliveryStore", bucketProps);
    const health = new lambda.Function(this, "ReferenceApi", { runtime: lambda.Runtime.NODEJS_22_X, handler: "index.handler", timeout: Duration.seconds(10), code: lambda.Code.fromInline("exports.handler=async()=>({statusCode:200,headers:{'content-type':'application/json'},body:JSON.stringify({status:'ok',service:'ubeeq-reference-api'})})") });
    const url = health.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE, cors: { allowedOrigins: ["*"], allowedMethods: [lambda.HttpMethod.GET] } });
    new CfnOutput(this, "ReferenceApiHealthUrl", { value: `${url.url}health` });
    new CfnOutput(this, "SourceStoreName", { value: sourceStore.bucketName });
    new CfnOutput(this, "DeliveryStoreName", { value: deliveryStore.bucketName });
  }
}
