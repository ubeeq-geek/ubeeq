import { CfnOutput, Duration, IgnoreMode, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
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
    // One stack is one authoritative regional cell. This value is deliberately
    // injected into every runtime rather than inferred from a global control plane.
    const cellId = this.node.tryGetContext("cellId") || process.env.UBEEQ_CELL_ID || `aws-${this.region}`;
    const cellRegion = this.node.tryGetContext("cellRegion") || process.env.UBEEQ_CELL_REGION || this.region;
    Tags.of(this).add("ubeeq:cell-id", cellId);
    Tags.of(this).add("ubeeq:cell-region", cellRegion);
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
    const routingDirectoryTableName = this.node.tryGetContext("routingDirectoryTableName") || process.env.UBEEQ_ROUTING_DIRECTORY_TABLE_NAME;
    const routingDirectoryTableArn = this.node.tryGetContext("routingDirectoryTableArn") || process.env.UBEEQ_ROUTING_DIRECTORY_TABLE_ARN;
    if (routingDirectoryTableName && !routingDirectoryTableArn) throw new Error("UBEEQ_ROUTING_DIRECTORY_TABLE_ARN is required with UBEEQ_ROUTING_DIRECTORY_TABLE_NAME so a cell can read a control-plane table in another region.");
    const runtimeEnvironment = { UBEEQ_INSTANCE_ID: "aws-reference", UBEEQ_CELL_ID: cellId, UBEEQ_CELL_REGION: cellRegion, UBEEQ_CELL_OPERATOR: "self-hosted", UBEEQ_PUBLIC_BASE_URL: referenceApiPublicBaseUrl, UBEEQ_RECORDS_TABLE: records.tableName, UBEEQ_SOURCE_BUCKET: sourceStore.bucketName, UBEEQ_JOBS_QUEUE_URL: jobs.queueUrl, UBEEQ_USER_POOL_ID: userPool.userPoolId, UBEEQ_USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId, UBEEQ_CREDENTIAL_SECRET_PREFIX: "ubeeq/credentials", ...(routingDirectoryTableName ? { UBEEQ_ROUTING_DIRECTORY_TABLE_NAME: routingDirectoryTableName } : {}) };
    const health = new lambda.Function(this, "ReferenceApi", { runtime: lambda.Runtime.NODEJS_22_X, handler: "lambda.handler", timeout: Duration.seconds(30), code: lambda.Code.fromAsset(referenceApiAsset, { ignoreMode: IgnoreMode.GLOB }), environment: runtimeEnvironment });
    const web = new lambda.Function(this, "ReferenceWeb", { runtime: lambda.Runtime.NODEJS_22_X, handler: "lambda.web", timeout: Duration.seconds(30), code: lambda.Code.fromAsset(referenceApiAsset, { ignoreMode: IgnoreMode.GLOB }), environment: { UBEEQ_REFERENCE_WEB_API_URL: referenceApiPublicBaseUrl } });
    const worker = new lambda.Function(this, "ReferenceWorker", { runtime: lambda.Runtime.NODEJS_22_X, handler: "lambda.worker", timeout: Duration.minutes(2), code: lambda.Code.fromAsset(referenceApiAsset, { ignoreMode: IgnoreMode.GLOB }), environment: runtimeEnvironment });
    records.grantReadWriteData(health); sourceStore.grantReadWrite(health); deliveryStore.grantReadWrite(health); jobs.grantConsumeMessages(health); jobs.grantSendMessages(health); credentialKey.grantRead(health);
    records.grantReadWriteData(worker); sourceStore.grantReadWrite(worker); deliveryStore.grantReadWrite(worker); jobs.grantConsumeMessages(worker); jobs.grantSendMessages(worker); credentialKey.grantRead(worker);
    if (routingDirectoryTableName && routingDirectoryTableArn) {
      const routingDirectory = dynamodb.Table.fromTableArn(this, "RoutingDirectory", routingDirectoryTableArn);
      // Route resolution is read-only in each cell. Migration writes belong to
      // a separately deployed, explicitly authorized control-plane worker.
      routingDirectory.grantReadData(health);
    }
    health.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:CreateSecret", "secretsmanager:GetSecretValue", "secretsmanager:UpdateSecret"], resources: [this.formatArn({ service: "secretsmanager", resource: "secret", resourceName: "ubeeq/credentials/*" })] }));
    worker.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:CreateSecret", "secretsmanager:GetSecretValue", "secretsmanager:UpdateSecret"], resources: [this.formatArn({ service: "secretsmanager", resource: "secret", resourceName: "ubeeq/credentials/*" })] }));
    worker.addEventSource(new lambdaEventSources.SqsEventSource(jobs, { batchSize: 1, reportBatchItemFailures: true }));
    new cloudwatch.Alarm(this, "JobDeadLetterAlarm", { metric: deadLetters.metricApproximateNumberOfMessagesVisible(), threshold: 1, evaluationPeriods: 1, alarmDescription: "Ubeeq durable jobs require manual recovery" });
    const url = health.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    const api = new apigwv2.HttpApi(this, "ReferenceApiGateway", { description: "Authenticated HTTP edge for the neutral Ubeeq reference API" });
    api.addRoutes({ path: "/{proxy+}", methods: [apigwv2.HttpMethod.ANY], integration: new apigwv2Integrations.HttpLambdaIntegration("ReferenceApiIntegration", health) });
    api.addRoutes({ path: "/", methods: [apigwv2.HttpMethod.ANY], integration: new apigwv2Integrations.HttpLambdaIntegration("ReferenceApiRootIntegration", health) });
    const webApi = new apigwv2.HttpApi(this, "ReferenceWebGateway", { description: "Plain reference-web edge for the neutral Ubeeq reference API" });
    webApi.addRoutes({ path: "/{proxy+}", methods: [apigwv2.HttpMethod.ANY], integration: new apigwv2Integrations.HttpLambdaIntegration("ReferenceWebIntegration", web) });
    webApi.addRoutes({ path: "/", methods: [apigwv2.HttpMethod.ANY], integration: new apigwv2Integrations.HttpLambdaIntegration("ReferenceWebRootIntegration", web) });
    const customDomainName = this.node.tryGetContext("referenceApiDomainName") || process.env.UBEEQ_REFERENCE_API_DOMAIN_NAME;
    const webCustomDomainName = this.node.tryGetContext("referenceWebDomainName") || process.env.UBEEQ_REFERENCE_WEB_DOMAIN_NAME;
    const publicHostedZoneId = this.node.tryGetContext("publicHostedZoneId") || process.env.UBEEQ_PUBLIC_HOSTED_ZONE_ID;
    const publicHostedZoneName = this.node.tryGetContext("publicHostedZoneName") || process.env.UBEEQ_PUBLIC_HOSTED_ZONE_NAME;
    const certificateArn = this.node.tryGetContext("referenceApiCertificateArn") || process.env.UBEEQ_REFERENCE_API_CERTIFICATE_ARN;
    if (customDomainName || publicHostedZoneId || publicHostedZoneName || certificateArn) {
      if (!customDomainName || !publicHostedZoneId || !publicHostedZoneName || !certificateArn) throw new Error("Custom API domains require UBEEQ_REFERENCE_API_DOMAIN_NAME, UBEEQ_PUBLIC_HOSTED_ZONE_ID, UBEEQ_PUBLIC_HOSTED_ZONE_NAME, and UBEEQ_REFERENCE_API_CERTIFICATE_ARN.");
      const normalizedZone = publicHostedZoneName.replace(/\.$/, "");
      const normalizedDomain = customDomainName.replace(/\.$/, "");
      const recordName = normalizedDomain === normalizedZone ? undefined : normalizedDomain.endsWith(`.${normalizedZone}`) ? normalizedDomain.slice(0, -(normalizedZone.length + 1)) : undefined;
      if (normalizedDomain !== normalizedZone && !recordName) throw new Error("UBEEQ_REFERENCE_API_DOMAIN_NAME must be the hosted-zone apex or a subdomain of UBEEQ_PUBLIC_HOSTED_ZONE_NAME.");
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "PublicHostedZone", { hostedZoneId: publicHostedZoneId, zoneName: normalizedZone });
      const certificate = acm.Certificate.fromCertificateArn(this, "ReferenceApiCertificate", certificateArn);
      const domain = new apigwv2.DomainName(this, "ReferenceApiCustomDomain", { domainName: normalizedDomain, certificate, securityPolicy: apigwv2.SecurityPolicy.TLS_1_2 });
      new apigwv2.ApiMapping(this, "ReferenceApiCustomDomainMapping", { api, domainName: domain, stage: api.defaultStage });
      new route53.ARecord(this, "ReferenceApiCustomDomainAlias", { zone, ...(recordName ? { recordName } : {}), target: route53.RecordTarget.fromAlias(new route53Targets.ApiGatewayv2DomainProperties(domain.regionalDomainName, domain.regionalHostedZoneId)) });
      if (webCustomDomainName) {
        if (webCustomDomainName.replace(/\.$/, "") !== normalizedZone) throw new Error("UBEEQ_REFERENCE_WEB_DOMAIN_NAME must equal UBEEQ_PUBLIC_HOSTED_ZONE_NAME.");
        const webDomain = new apigwv2.DomainName(this, "ReferenceWebCustomDomain", { domainName: normalizedZone, certificate, securityPolicy: apigwv2.SecurityPolicy.TLS_1_2 });
        new apigwv2.ApiMapping(this, "ReferenceWebCustomDomainMapping", { api: webApi, domainName: webDomain, stage: webApi.defaultStage });
        new route53.ARecord(this, "ReferenceWebCustomDomainAlias", { zone, target: route53.RecordTarget.fromAlias(new route53Targets.ApiGatewayv2DomainProperties(webDomain.regionalDomainName, webDomain.regionalHostedZoneId)) });
        new CfnOutput(this, "ReferenceWebCustomDomainUrl", { value: `https://${normalizedZone}` });
      }
      new CfnOutput(this, "ReferenceApiCustomDomainUrl", { value: `https://${customDomainName}` });
    }
    new CfnOutput(this, "ReferenceApiUrl", { value: url.url });
    new CfnOutput(this, "CellId", { value: cellId });
    new CfnOutput(this, "CellRegion", { value: cellRegion });
    new CfnOutput(this, "ReferenceApiGatewayUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "ReferenceWebGatewayUrl", { value: webApi.apiEndpoint });
    new CfnOutput(this, "SourceStoreName", { value: sourceStore.bucketName });
    new CfnOutput(this, "DeliveryStoreName", { value: deliveryStore.bucketName });
    new CfnOutput(this, "RecordsTableName", { value: records.tableName });
    new CfnOutput(this, "JobsQueueUrl", { value: jobs.queueUrl });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "CredentialSecretPrefix", { value: "ubeeq/credentials" });
  }
}
