import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
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
    new CfnOutput(this, "RoutingDirectoryTableName", { value: routes.tableName });
    new CfnOutput(this, "RoutingDirectoryTableArn", { value: routes.tableArn });
  }
}
