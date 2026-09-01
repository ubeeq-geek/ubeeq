# Ubeeq

Ubeeq is a brand-neutral, self-hostable platform for creator work, assets, integrations, delivery, and extension-based product composition.

Hosted products consume Ubeeq through versioned packages and extension contracts. This repository intentionally contains no hosted-product branding, pricing, policy decisions, credentials, or operational runbooks.

## Local development

The reference instance runs entirely on the local machine: SQLite state,
filesystem objects, local password sessions, and a local durable job queue. It
requires Node 22.5 or newer but no AWS credentials or external services. The
local adapter relies on Node's experimental built-in `node:sqlite` module.

```sh
nvm install 22
nvm use 22
```

```sh
npm ci
```

Start the API in one terminal:

```sh
npm run dev:api
```

Then start the creator workspace in a second terminal:

```sh
npm run dev:web
```

Open `http://127.0.0.1:4173`. The workspace proxies API requests to
`http://127.0.0.1:4100`; set `UBEEQ_REFERENCE_API_URL` before starting the web
server to use another API address. State and uploaded objects are stored in
`var/reference` and can be removed when a fresh local instance is wanted.

The optional operations UI follows the same pattern:

```sh
npm run dev:admin
```

It listens on `http://127.0.0.1:4174`. The older `dev:reference*` script names
remain as backward-compatible aliases.

## Packages

- `@ubeeq/core` — neutral domain entities and lifecycle contracts.
- `@ubeeq/auth` — authenticated-subject and authorization contracts.
- `@ubeeq/billing` — append-only usage and credit-reservation ledger primitives.
- `@ubeeq/extension-sdk` — versioned extension manifests and product-policy interfaces.
- `@ubeeq/ui` — unbranded UI token, accessible-action, and localization contracts.
- `@ubeeq/integrations` — capability vocabulary, operation gates, and executable connector conformance runner.
- `@ubeeq/moderation` — evidence, review-case, hold, and auditable human-decision lifecycle primitives.
- `@ubeeq/processing` — asset-processing requests and idempotent usage measurement interfaces.
- `@ubeeq/storage` — object storage and delivery adapter interfaces.
- `@ubeeq/jobs` — durable queue, scheduling, leasing, retry, and recovery ports.
- `@ubeeq/persistence` — durable repository, transaction, revision, pagination, and adapter conformance contracts.
- `@ubeeq/adapter-local` — SQLite, filesystem storage/delivery, local password sessions, and durable local jobs.
- `@ubeeq/adapter-machine` — PostgreSQL repositories and a durable multi-worker queue for scalable machine cells.
- `@ubeeq/adapter-aws` — optional AWS provider implementations for DynamoDB, S3, SQS, Cognito, and related ports.
- `@ubeeq/federation` — remote actor and publication-reference contracts.
- `@ubeeq/deployment-machine-compact` — neutral configuration for a compact, single-cell machine deployment.
- `@ubeeq/deployment-platform` — versioned deployment-artifact provenance and regional rollout contracts.
- `@ubeeq/api` — startup validation for extension compatibility.
- `apps/web-reference` and `apps/admin-reference` — minimal neutral composition examples.
- `apps/reference-api` — runnable local API reference for the creator-to-public-Work flow.

## Extension compatibility

Extensions declare an API version and the contracts they implement. `@ubeeq/api` validates manifests at startup and fails clearly if a required extension is missing or incompatible. See [`packages/extension-sdk`](packages/extension-sdk) for the initial contracts.

The SDK also defines platform-neutral integration capabilities, such as metadata import, work publication, activity synchronization, and remote deletion. A product decides whether and how a compatible connector is offered.

## Repository boundary

Public Ubeeq code may provide reusable mechanisms such as storage, processing, audit, authorization hooks, federation protocols, and integration lifecycle contracts. Product policy, branding, commercial plans, discovery decisions, operational procedures, and credentials belong in private product repositories.

## Deployment profiles

Ubeeq separates reusable provider adapters from runnable deployment models:

- **Local reference** — [`deployments/local`](deployments/local) composes the
  reference API with `adapters/local`: SQLite, filesystem storage, local jobs,
  and no cloud account.
- **Compact machine cell** — [`deployments/machine/compact`](deployments/machine/compact): a low-operations, cloud-free, single authoritative cell. [`examples/machine/compact`](examples/machine/compact) runs the reference API, creator workspace, and operations workspace with Compose.
- **AWS serverless single-cell** — [`deployments/aws-serverless/single-cell`](deployments/aws-serverless/single-cell): Lambda/API Gateway, DynamoDB, S3, SQS, Cognito, and optional CloudFront for one scalable regional cell.
- **AWS serverless multi-cell** — [`deployments/aws-serverless/multi-cell`](deployments/aws-serverless/multi-cell): optional routing/migration control-plane infrastructure that composes independent single cells; it does not create a global mutable data plane.
- **Scalable machine single-cell** — [`deployments/machine/scalable-single-cell`](deployments/machine/scalable-single-cell) composes PostgreSQL and an S3-compatible object store through `@ubeeq/adapter-machine`; its remaining identity and deployment composition work is tracked with that profile.
- **Future profiles** — `deployments/machine/scalable-multi-cell` and `deployments/kubernetes/scalable-*` reserve provider-neutral multi-cell and Kubernetes paths.

[`deployments/machine/compact/reference-config.json`](deployments/machine/compact/reference-config.json) is the product-neutral starting point for compact machine configuration. It contains neither hosted product settings nor credentials.

For AWS serverless regional planning, including the separate optional
Rekognition Image moderation-label and face-age-range capabilities, see
[`docs/aws-regional-capabilities.md`](docs/aws-regional-capabilities.md).

## Portable reference-instance plan

The staged implementation plan for the local reference instance, durable adapters, optional AWS composition, and compatibility gates is in [`docs/portable-reference-instance-implementation-plan.md`](docs/portable-reference-instance-implementation-plan.md).
