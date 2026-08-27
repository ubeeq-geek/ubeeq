import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

/** Neutral, self-hostable foundation; product domains, policy, and credentials are intentionally absent. */
export class SelfHostReferenceStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const bucketProps = { blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true, versioned: true, removalPolicy: RemovalPolicy.RETAIN, autoDeleteObjects: false };
    const sourceStore = new s3.Bucket(this, "SourceStore", bucketProps);
    const deliveryStore = new s3.Bucket(this, "DeliveryStore", bucketProps);
    const records = new dynamodb.Table(this, "Records", { partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING }, sortKey: { name: "sk", type: dynamodb.AttributeType.STRING }, billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, encryption: dynamodb.TableEncryption.AWS_MANAGED, removalPolicy: RemovalPolicy.RETAIN });
    const deadLetters = new sqs.Queue(this, "DeadLetters", { encryption: sqs.QueueEncryption.SQS_MANAGED, retentionPeriod: Duration.days(14), removalPolicy: RemovalPolicy.RETAIN });
    const jobs = new sqs.Queue(this, "Jobs", { encryption: sqs.QueueEncryption.SQS_MANAGED, deadLetterQueue: { queue: deadLetters, maxReceiveCount: 3 }, visibilityTimeout: Duration.minutes(5), removalPolicy: RemovalPolicy.RETAIN });
    new events.Rule(this, "RecoverySchedule", { schedule: events.Schedule.rate(Duration.minutes(5)), description: "Neutral scheduled recovery trigger for Ubeeq durable jobs" });
    const userPool = new cognito.UserPool(this, "Users", { selfSignUpEnabled: false, signInAliases: { email: true }, removalPolicy: RemovalPolicy.RETAIN, passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: false } });
    const userPoolClient = userPool.addClient("ReferenceApi", { authFlows: { userPassword: true, userSrp: true } });
    const credentialKey = new secretsmanager.Secret(this, "CredentialVaultKey", { description: "Application-owned encryption material for the optional Ubeeq AWS credential vault", removalPolicy: RemovalPolicy.RETAIN });
    const health = new lambda.Function(this, "ReferenceApi", { runtime: lambda.Runtime.NODEJS_22_X, handler: "index.handler", timeout: Duration.seconds(10), code: lambda.Code.fromInline("exports.handler=async()=>({statusCode:200,headers:{'content-type':'application/json'},body:JSON.stringify({status:'ok',service:'ubeeq-reference-api'})})") });
    records.grantReadWriteData(health); sourceStore.grantReadWrite(health); deliveryStore.grantReadWrite(health); jobs.grantConsumeMessages(health); jobs.grantSendMessages(health); credentialKey.grantRead(health);
    health.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:CreateSecret", "secretsmanager:GetSecretValue", "secretsmanager:UpdateSecret"], resources: [this.formatArn({ service: "secretsmanager", resource: "secret", resourceName: "ubeeq/credentials/*" })] }));
    new cloudwatch.Alarm(this, "JobDeadLetterAlarm", { metric: deadLetters.metricApproximateNumberOfMessagesVisible(), threshold: 1, evaluationPeriods: 1, alarmDescription: "Ubeeq durable jobs require manual recovery" });
    const url = health.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE, cors: { allowedOrigins: ["*"], allowedMethods: [lambda.HttpMethod.GET] } });
    new CfnOutput(this, "ReferenceApiHealthUrl", { value: `${url.url}health` });
    new CfnOutput(this, "SourceStoreName", { value: sourceStore.bucketName });
    new CfnOutput(this, "DeliveryStoreName", { value: deliveryStore.bucketName });
    new CfnOutput(this, "RecordsTableName", { value: records.tableName });
    new CfnOutput(this, "JobsQueueUrl", { value: jobs.queueUrl });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "CredentialSecretPrefix", { value: "ubeeq/credentials" });
  }
}
