import { CfnOutput, Duration, IgnoreMode, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { resolve } from "node:path";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

/**
 * Optional operator control plane for multiple independent Ubeeq cells.
 * This table holds route/checkpoint metadata only and is deliberately not a
 * regional cell records table or a DynamoDB global table.
 */
export class AwsServerlessMultiCellStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const routes = new dynamodb.Table(this, "RoutingDirectory", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const deadLetters = new sqs.Queue(this, "MigrationDeadLetters", { encryption: sqs.QueueEncryption.SQS_MANAGED, retentionPeriod: Duration.days(14), removalPolicy: RemovalPolicy.RETAIN });
    const commands = new sqs.Queue(this, "MigrationCommands", { encryption: sqs.QueueEncryption.SQS_MANAGED, visibilityTimeout: Duration.minutes(15), deadLetterQueue: { queue: deadLetters, maxReceiveCount: 3 }, removalPolicy: RemovalPolicy.RETAIN });
    const referenceApiAsset = this.node.tryGetContext("referenceApiAssetPath") || process.env.UBEEQ_REFERENCE_API_ASSET_PATH || resolve(__dirname, "../../../../apps/reference-api/lambda-package");
    const worker = new lambda.Function(this, "MigrationControlWorker", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "lambda.migrationControlWorker",
      timeout: Duration.minutes(14),
      code: lambda.Code.fromAsset(referenceApiAsset, { ignoreMode: IgnoreMode.GLOB }),
      environment: { UBEEQ_ROUTING_DIRECTORY_TABLE_NAME: routes.tableName, UBEEQ_ROUTING_DIRECTORY_REGION: this.region },
    });
    const operatorPrincipalArn = this.node.tryGetContext("migrationOperatorPrincipalArn") || process.env.UBEEQ_MIGRATION_OPERATOR_PRINCIPAL_ARN || "arn:aws:iam::000000000000:role/UNCONFIGURED";
    const operatorApi = new lambda.Function(this, "MigrationControlApi", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "lambda.migrationControlApi",
      timeout: Duration.seconds(30),
      code: lambda.Code.fromAsset(referenceApiAsset, { ignoreMode: IgnoreMode.GLOB }),
      environment: { UBEEQ_ROUTING_DIRECTORY_TABLE_NAME: routes.tableName, UBEEQ_ROUTING_DIRECTORY_REGION: this.region, UBEEQ_MIGRATION_COMMANDS_QUEUE_URL: commands.queueUrl, UBEEQ_MIGRATION_OPERATOR_PRINCIPAL_ARN: operatorPrincipalArn },
    });
    routes.grantReadWriteData(worker);
    routes.grantReadData(operatorApi); commands.grantSendMessages(operatorApi);
    worker.addEventSource(new lambdaEventSources.SqsEventSource(commands, { batchSize: 1, reportBatchItemFailures: true }));
    // The operator must opt in exact bucket ARNs for each admitted cell. There
    // is intentionally no wildcard S3 grant across accounts or cells.
    const migrationBucketArns = String(this.node.tryGetContext("migrationBucketArns") || process.env.UBEEQ_MIGRATION_BUCKET_ARNS || "").split(",").map((value) => value.trim()).filter(Boolean);
    if (migrationBucketArns.length) worker.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:PutObjectTagging"], resources: migrationBucketArns.flatMap((bucketArn) => [`${bucketArn}/*`]) }));
    // Registered cells also need a resource policy allowing this role (or its
    // account) to invoke their private migration Lambda. The narrow function
    // ARNs are supplied by the operator, never inferred from public routes.
    const migrationFunctionArns = String(this.node.tryGetContext("migrationFunctionArns") || process.env.UBEEQ_MIGRATION_FUNCTION_ARNS || "").split(",").map((value) => value.trim()).filter(Boolean);
    if (migrationFunctionArns.length) worker.addToRolePolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: migrationFunctionArns }));
    new CfnOutput(this, "RoutingDirectoryTableName", { value: routes.tableName });
    new CfnOutput(this, "RoutingDirectoryTableArn", { value: routes.tableArn });
    new CfnOutput(this, "MigrationCommandsQueueUrl", { value: commands.queueUrl });
    new CfnOutput(this, "MigrationControlWorkerArn", { value: worker.functionArn });
    new CfnOutput(this, "MigrationControlWorkerRoleArn", { value: worker.role!.roleArn });
    new CfnOutput(this, "MigrationControlOperatorUrl", { value: operatorApi.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM }).url });
  }
}
