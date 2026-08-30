import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

const required = (scope: Construct, name: string): string => {
  const value = scope.node.tryGetContext(name) || process.env[`UBEEQ_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).replace(/^_/, "").toUpperCase()}`];
  if (!value) throw new Error(`Set CDK context ${name} (or its UBEEQ_* environment equivalent).`);
  return String(value);
};

/**
 * Production promotion is deliberately AWS-native: GitHub supplies source only;
 * CodePipeline pauses before deploy until an AWS-authenticated operator approves.
 */
export class AwsServerlessProductionPromotionStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const connectionArn = required(this, "githubConnectionArn");
    const repository = this.node.tryGetContext("githubRepository") || process.env.UBEEQ_GITHUB_REPOSITORY || "ubeeq-geek/ubeeq";
    const branch = this.node.tryGetContext("githubBranch") || process.env.UBEEQ_GITHUB_BRANCH || "main";
    const sourceRegion = required(this, "sourceRegion");
    const destinationRegion = required(this, "destinationRegion");
    const controlRegion = required(this, "controlRegion");
    const sourceStack = required(this, "sourceStack");
    const destinationStack = required(this, "destinationStack");
    const controlStack = required(this, "controlStack");
    const sourceCellId = required(this, "sourceCellId");
    const destinationCellId = required(this, "destinationCellId");
    const sourceBaseUrl = required(this, "sourceBaseUrl");
    const destinationBaseUrl = required(this, "destinationBaseUrl");

    const source = new codepipeline.Artifact("Source");
    const plan = new codepipeline.Artifact("Plan");
    const deployRole = new iam.Role(this, "ProductionDeployBuildRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      description: "Deploys only the configured Ubeeq production regional cells after CodePipeline manual approval.",
    });
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sts:AssumeRole", "sts:TagSession"],
      resources: [sourceRegion, destinationRegion].flatMap((region) => ["deploy-role", "file-publishing-role", "lookup-role"].map((role) => `arn:aws:iam::${this.account}:role/cdk-hnb659fds-${role}-${this.account}-${region}`)),
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ["cloudformation:DescribeStacks"], resources: ["*"] }));

    const config = {
      UBEEQ_SOURCE_REGION: sourceRegion,
      UBEEQ_DESTINATION_REGION: destinationRegion,
      UBEEQ_CONTROL_REGION: controlRegion,
      UBEEQ_SOURCE_STACK: sourceStack,
      UBEEQ_DESTINATION_STACK: destinationStack,
      UBEEQ_CONTROL_STACK: controlStack,
      UBEEQ_SOURCE_CELL_ID: sourceCellId,
      UBEEQ_DESTINATION_CELL_ID: destinationCellId,
      UBEEQ_SOURCE_BASE_URL: sourceBaseUrl,
      UBEEQ_DESTINATION_BASE_URL: destinationBaseUrl,
      UBEEQ_MIGRATION_OPERATOR_PRINCIPAL_ARN: deployRole.roleArn,
    };
    const planProject = new codebuild.PipelineProject(this, "Plan", {
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      buildSpec: codebuild.BuildSpec.fromObject({ version: "0.2", phases: { install: { "runtime-versions": { nodejs: 22 } }, build: { commands: ["npm ci", "npm run build", "npm run synth:aws-serverless-single-cell", "npm run synth:aws-serverless-multi-cell", "printf '%s\\n' \"$CODEBUILD_RESOLVED_SOURCE_VERSION\" > promotion-revision.txt"] } }, artifacts: { files: ["promotion-revision.txt"] } }),
    });
    const deployProject = new codebuild.PipelineProject(this, "Deploy", {
      role: deployRole,
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, environmentVariables: Object.fromEntries(Object.entries(config).map(([name, value]) => [name, { value }])) },
      buildSpec: codebuild.BuildSpec.fromObject({ version: "0.2", phases: { install: { "runtime-versions": { nodejs: 22 } }, build: { commands: ["npm ci", "node scripts/deploy-aws-serverless-regional-cells.mjs"] } } }),
    });
    const pipeline = new codepipeline.Pipeline(this, "Pipeline", { crossAccountKeys: true });
    pipeline.addStage({ stageName: "Source", actions: [new actions.CodeStarConnectionsSourceAction({ actionName: "GitHubMain", owner: repository.split("/")[0], repo: repository.split("/")[1], branch, connectionArn, output: source })] });
    pipeline.addStage({ stageName: "Plan", actions: [new actions.CodeBuildAction({ actionName: "BuildAndSynth", project: planProject, input: source, outputs: [plan] })] });
    pipeline.addStage({ stageName: "ApproveProduction", actions: [new actions.ManualApprovalAction({ actionName: "AWSOperatorApproval", additionalInformation: "Review the pinned source revision and synthesized production change before approving deployment.", externalEntityLink: `https://github.com/${repository}/commits/${branch}` })] });
    pipeline.addStage({ stageName: "Deploy", actions: [new actions.CodeBuildAction({ actionName: "DeployRegionalCells", project: deployProject, input: source })] });
    new CfnOutput(this, "ProductionPromotionPipelineName", { value: pipeline.pipelineName });
    new CfnOutput(this, "ProductionPromotionPipelineArn", { value: pipeline.pipelineArn });
  }
}
