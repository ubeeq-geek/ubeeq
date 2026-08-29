# AWS regional capabilities

This matrix describes the optional AWS serverless deployment profile. It does
not change Ubeeq's portable baseline: a local or machine deployment needs no
AWS account and no Rekognition service.

## Baseline serverless cell

An AWS serverless cell uses API Gateway, Lambda, DynamoDB, S3, SQS,
EventBridge, Cognito, Secrets Manager, and optionally CloudFront. Choose a
region where those services meet the deployment's required features, quotas,
data-residency commitments, and pricing. The cell stays authoritative for its
own creator data; CDN caching does not make another region a write target.

The current development cells have been deployed and health-checked in:

| Region | Cell ID | Status |
| --- | --- | --- |
| `us-east-2` | `ubeeq-dev-us-east-2` | Healthy |
| `eu-central-1` | `ubeeq-dev-eu-central-1` | Healthy |

This is a deployment smoke check, not a claim that these are the only regions
where the serverless profile can run.

## Optional Rekognition Image evidence

Rekognition is an optional processing-evidence adapter. It is not a Ubeeq
moderation policy, age-verification system, or prerequisite for image/video
uploads. A product or operator decides whether to install it and how to treat
its evidence.

Two separate image operations matter:

| Evidence | Rekognition operation | Meaning in Ubeeq |
| --- | --- | --- |
| Moderation labels | `DetectModerationLabels` | Optional machine-produced evidence for a policy/reviewer; it does not make an enforcement decision. |
| Face age range | `DetectFaces` with `AGE_RANGE` | Optional estimated age-range evidence for a detected face; it is not identity proof or age verification. |

Ubeeq's video approach remains portable: extract selected frames through the
processing pipeline and submit each image frame to whichever image-evidence
adapter is configured. It does **not** require Rekognition Video, streaming
video APIs, or a video-moderation regional matrix.

### Commercial AWS Regions

AWS documents Rekognition Image endpoints in the following commercial regions.
Except where AWS lists an operation restriction, these regions are suitable for
both optional image-evidence calls:

| Capability | Regions |
| --- | --- |
| Moderation-label evidence (`DetectModerationLabels`) and age-range evidence (`DetectFaces`) | `us-east-1`, `us-east-2`, `us-west-1`, `us-west-2`, `ap-south-1`, `ap-northeast-1`, `ap-northeast-2`, `ap-southeast-1`, `ap-southeast-2`, `ap-southeast-5`, `ap-southeast-7`, `eu-central-1`, `eu-west-1`, `eu-west-2`, `eu-south-2`, `il-central-1`, `sa-east-1` |
| Age-range evidence only | `ca-central-1` |

`ca-central-1` is intentionally separate: AWS explicitly lists `DetectFaces`
among the operations it supports there, but does not list
`DetectModerationLabels`. `il-central-1` is included in the first row because
AWS explicitly lists both face detection and moderation there.

AWS also lists a Rekognition endpoint in `us-gov-west-1`. It is a separate
partition and is outside this commercial deployment matrix; validate the
complete serverless dependency set and partition-specific identity/deployment
configuration before treating it as supported.

## Deployment decision

Choose a region first for the cell's data-home, service availability, and
operator commitments. Add the optional image-evidence adapter only when both
of its requested operations are available in that same cell region. A missing
moderation-label operation must leave the adapter disabled or configured for
age-range evidence only; it must not cause processing or publishing to fail by
default.

Recheck the specific service operation and quota before a production rollout.
AWS can change regional availability and quotas independently of Ubeeq
releases.

## Sources

- [Amazon Rekognition endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/rekognition.html)
- [Amazon Rekognition `DetectFaces` API](https://docs.aws.amazon.com/rekognition/latest/APIReference/API_DetectFaces.html)
