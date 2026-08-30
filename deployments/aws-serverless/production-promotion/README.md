# AWS serverless production promotion

This optional stack keeps production deployment authority inside the production AWS account. Its CodePipeline source is `ubeeq-geek/ubeeq` on `main`, but deployment pauses at an AWS CodePipeline **Manual Approval** action. GitHub Actions receives no production AWS role.

The deployment project deploys the control plane, both regional cells, then updates the control plane with the exact cell migration grants. It assumes only the CDK bootstrap deploy, file-publishing, and lookup roles for the two configured cell regions.

Create and authorize an AWS CodeStar GitHub connection in the production account first. Then synthesize or deploy with explicit values:

```sh
UBEEQ_GITHUB_CONNECTION_ARN=arn:aws:codestar-connections:REGION:ACCOUNT:connection/ID \
UBEEQ_SOURCE_REGION=us-east-2 UBEEQ_DESTINATION_REGION=eu-central-1 UBEEQ_CONTROL_REGION=us-east-2 \
UBEEQ_SOURCE_STACK=UbeeqSelfHostProd UBEEQ_DESTINATION_STACK=UbeeqSelfHostProdEuCentral1 UBEEQ_CONTROL_STACK=UbeeqMultiCellProd \
UBEEQ_SOURCE_CELL_ID=prod-us-east-2 UBEEQ_DESTINATION_CELL_ID=prod-eu-central-1 \
UBEEQ_SOURCE_BASE_URL=https://api.ubeeq.site UBEEQ_DESTINATION_BASE_URL=https://api-eu.ubeeq.site \
npm run deploy --workspace @ubeeq/deployment-aws-serverless-production-promotion -- --require-approval never
```

Approve only after reviewing the pipeline’s source revision and plan. Rejecting or leaving approval pending cannot mutate production cells.
