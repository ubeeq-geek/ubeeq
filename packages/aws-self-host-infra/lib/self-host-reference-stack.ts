import { CfnOutput, Duration, IgnoreMode, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { resolve } from "node:path";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
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
    records.addGlobalSecondaryIndex({ indexName: "repository-id-index", partitionKey: { name: "repository", type: dynamodb.AttributeType.STRING }, sortKey: { name: "id", type: dynamodb.AttributeType.STRING } });
    const deadLetters = new sqs.Queue(this, "DeadLetters", { encryption: sqs.QueueEncryption.SQS_MANAGED, retentionPeriod: Duration.days(14), removalPolicy: RemovalPolicy.RETAIN });
    const jobs = new sqs.Queue(this, "Jobs", { encryption: sqs.QueueEncryption.SQS_MANAGED, deadLetterQueue: { queue: deadLetters, maxReceiveCount: 3 }, visibilityTimeout: Duration.minutes(5), removalPolicy: RemovalPolicy.RETAIN });
    new events.Rule(this, "RecoverySchedule", { schedule: events.Schedule.rate(Duration.minutes(5)), description: "Neutral scheduled recovery trigger for Ubeeq durable jobs" });
    const userPool = new cognito.UserPool(this, "Users", { selfSignUpEnabled: false, signInAliases: { email: true }, removalPolicy: RemovalPolicy.RETAIN, passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: false } });
    const userPoolClient = userPool.addClient("ReferenceApi", { authFlows: { userPassword: true, userSrp: true } });
    const credentialKey = new secretsmanager.Secret(this, "CredentialVaultKey", { description: "Application-owned encryption material for the optional Ubeeq AWS credential vault", removalPolicy: RemovalPolicy.RETAIN });
    const referenceApiAsset = this.node.tryGetContext("referenceApiAssetPath") || process.env.UBEEQ_REFERENCE_API_ASSET_PATH || resolve(__dirname, "../../../apps/reference-api/lambda-package");
    const referenceApiPublicBaseUrl = this.node.tryGetContext("referenceApiPublicBaseUrl") || process.env.UBEEQ_REFERENCE_API_PUBLIC_BASE_URL || "https://reference.invalid";
    const health = new lambda.Function(this, "ReferenceApi", { runtime: lambda.Runtime.NODEJS_22_X, handler: "lambda.handler", timeout: Duration.seconds(30), code: lambda.Code.fromAsset(referenceApiAsset, { ignoreMode: IgnoreMode.GLOB }), environment: { UBEEQ_INSTANCE_ID: "aws-reference", UBEEQ_PUBLIC_BASE_URL: referenceApiPublicBaseUrl, UBEEQ_RECORDS_TABLE: records.tableName, UBEEQ_SOURCE_BUCKET: sourceStore.bucketName, UBEEQ_JOBS_QUEUE_URL: jobs.queueUrl, UBEEQ_USER_POOL_ID: userPool.userPoolId, UBEEQ_USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId, UBEEQ_CREDENTIAL_SECRET_PREFIX: "ubeeq/credentials" } });
    const worker = new lambda.Function(this, "ReferenceWorker", { runtime: lambda.Runtime.NODEJS_22_X, handler: "lambda.worker", timeout: Duration.minutes(2), code: lambda.Code.fromAsset(referenceApiAsset, { ignoreMode: IgnoreMode.GLOB }), environment: { UBEEQ_INSTANCE_ID: "aws-reference", UBEEQ_PUBLIC_BASE_URL: referenceApiPublicBaseUrl, UBEEQ_RECORDS_TABLE: records.tableName, UBEEQ_SOURCE_BUCKET: sourceStore.bucketName, UBEEQ_JOBS_QUEUE_URL: jobs.queueUrl, UBEEQ_USER_POOL_ID: userPool.userPoolId, UBEEQ_USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId, UBEEQ_CREDENTIAL_SECRET_PREFIX: "ubeeq/credentials" } });
    records.grantReadWriteData(health); sourceStore.grantReadWrite(health); deliveryStore.grantReadWrite(health); jobs.grantConsumeMessages(health); jobs.grantSendMessages(health); credentialKey.grantRead(health);
    records.grantReadWriteData(worker); sourceStore.grantReadWrite(worker); deliveryStore.grantReadWrite(worker); jobs.grantConsumeMessages(worker); jobs.grantSendMessages(worker); credentialKey.grantRead(worker);
    health.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:CreateSecret", "secretsmanager:GetSecretValue", "secretsmanager:UpdateSecret"], resources: [this.formatArn({ service: "secretsmanager", resource: "secret", resourceName: "ubeeq/credentials/*" })] }));
    worker.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:CreateSecret", "secretsmanager:GetSecretValue", "secretsmanager:UpdateSecret"], resources: [this.formatArn({ service: "secretsmanager", resource: "secret", resourceName: "ubeeq/credentials/*" })] }));
    worker.addEventSource(new lambdaEventSources.SqsEventSource(jobs, { batchSize: 1, reportBatchItemFailures: true }));
    new cloudwatch.Alarm(this, "JobDeadLetterAlarm", { metric: deadLetters.metricApproximateNumberOfMessagesVisible(), threshold: 1, evaluationPeriods: 1, alarmDescription: "Ubeeq durable jobs require manual recovery" });
    const url = health.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    const api = new apigwv2.HttpApi(this, "ReferenceApiGateway", { description: "Authenticated HTTP edge for the neutral Ubeeq reference API" });
    api.addRoutes({ path: "/{proxy+}", methods: [apigwv2.HttpMethod.ANY], integration: new apigwv2Integrations.HttpLambdaIntegration("ReferenceApiIntegration", health) });
    api.addRoutes({ path: "/", methods: [apigwv2.HttpMethod.ANY], integration: new apigwv2Integrations.HttpLambdaIntegration("ReferenceApiRootIntegration", health) });
    const customDomainName = this.node.tryGetContext("referenceApiDomainName") || process.env.UBEEQ_REFERENCE_API_DOMAIN_NAME;
    const publicHostedZoneId = this.node.tryGetContext("publicHostedZoneId") || process.env.UBEEQ_PUBLIC_HOSTED_ZONE_ID;
    const certificateArn = this.node.tryGetContext("referenceApiCertificateArn") || process.env.UBEEQ_REFERENCE_API_CERTIFICATE_ARN;
    if (customDomainName || publicHostedZoneId || certificateArn) {
      if (!customDomainName || !publicHostedZoneId || !certificateArn) throw new Error("Custom API domains require UBEEQ_REFERENCE_API_DOMAIN_NAME, UBEEQ_PUBLIC_HOSTED_ZONE_ID, and UBEEQ_REFERENCE_API_CERTIFICATE_ARN.");
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "PublicHostedZone", { hostedZoneId: publicHostedZoneId, zoneName: customDomainName });
      const domain = new apigwv2.DomainName(this, "ReferenceApiCustomDomain", { domainName: customDomainName, certificate: acm.Certificate.fromCertificateArn(this, "ReferenceApiCertificate", certificateArn), securityPolicy: apigwv2.SecurityPolicy.TLS_1_2 });
      new apigwv2.ApiMapping(this, "ReferenceApiCustomDomainMapping", { api, domainName: domain, stage: api.defaultStage });
      new route53.ARecord(this, "ReferenceApiCustomDomainAlias", { zone, target: route53.RecordTarget.fromAlias(new route53Targets.ApiGatewayv2DomainProperties(domain.regionalDomainName, domain.regionalHostedZoneId)) });
      new CfnOutput(this, "ReferenceApiCustomDomainUrl", { value: `https://${customDomainName}` });
    }
    new CfnOutput(this, "ReferenceApiUrl", { value: url.url });
    new CfnOutput(this, "ReferenceApiGatewayUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "SourceStoreName", { value: sourceStore.bucketName });
    new CfnOutput(this, "DeliveryStoreName", { value: deliveryStore.bucketName });
    new CfnOutput(this, "RecordsTableName", { value: records.tableName });
    new CfnOutput(this, "JobsQueueUrl", { value: jobs.queueUrl });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "CredentialSecretPrefix", { value: "ubeeq/credentials" });
  }
}
