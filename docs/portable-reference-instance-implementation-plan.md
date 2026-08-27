# Ubeeq portable reference instance implementation plan

**Status:** Proposed  
**Scope:** Public Ubeeq repository

## Purpose

This plan turns Ubeeq's portable domain contracts into a usable, self-hostable reference platform without making AWS, DynamoDB, Cognito, S3, or hosted-product policy a requirement.

It is organized into parallel work streams with clear ownership boundaries. The first short foundation milestone prevents incompatible ports, duplicate adapters, and accidental cloud coupling.

## Current baseline

Ubeeq already has neutral packages for core, authentication, storage, processing, moderation, integrations, federation, API composition, UI, deployment contracts, and self-hosting. It also has a minimal reference web application and an AWS-oriented self-host infrastructure package.

The principal gap is that the reference application is still an extension/health demonstration rather than a durable, end-to-end instance. Model contracts are present in several areas, but durable ports, local adapters, and application-service composition need to be established.

## Work-stream overview

| Stream | Scope | Primary deliverable | Depends on |
| --- | --- | --- | --- |
| 0. Contracts and guardrails | Repository, identity, storage, jobs, configuration contracts; boundary CI | Versioned ports and conformance-test kit | Start first |
| 1. Local reference vertical slice | Reference API, SQLite, local identity, filesystem storage, upload/publish/export | One-command local creator-to-public-Work flow | Stream 0 |
| 2. Durable workflows | Jobs, processing, moderation, audit, recovery, collections/publications | Resumable, auditable lifecycle services | Stream 0; integrates with Stream 1 |
| 3. Portability, integrations, federation | Export/import, connector runtime, credential-vault contracts, federation protocol | Portable migration and reference connector/protocol flow | Stream 0; integrates with Stream 1 |
| 4. Reference UX and self-host distribution | Creator/public/admin UI, Compose, backup/restore documentation | Plain usable UI and generic self-host bundle | Stream 1 |
| 5. Optional AWS implementation | AWS adapters, CDK example, local-to-AWS migration | Adapter contract and end-to-end parity | Streams 0–2 |

## Stream 0 — Contracts and guardrails

This is a short but mandatory foundation milestone. It should take one or two focused iterations and own public interface changes.

### Deliverables

- Create `@ubeeq/persistence`.
  - Repository ports for creator, Work, Asset, Collection, publication intent/state, moderation, usage, integrations, exports/imports, and federation references.
  - Transaction boundaries, optimistic revision semantics, uniqueness constraints, cursor pagination, idempotency-key retention, and atomic multi-record operations.
  - Shared repository conformance fixtures.
- Expand provider-neutral ports in existing packages.
  - `@ubeeq/auth`: subject/session verification, accounts, delegation, roles, scopes, recovery, verification, and revocation.
  - `@ubeeq/storage`: upload initiation/completion, checksums, immutable object versions, delivery grants, and lifecycle signals.
  - `@ubeeq/jobs`: durable queue, lease, retry, dead-letter, cancellation, scheduler, and recovery contracts.
- Add a clearly scoped reference configuration/composition module.
  - Validate instance configuration at startup.
  - Validate extension manifest compatibility.
  - Use explicit dependency injection for every adapter.
- Add CI boundary checks.
  - Reject cloud SDK/CDK imports outside approved AWS adapter/example packages.
  - Preserve the hosted-product-name boundary check.
  - Require every adapter to execute the same conformance suite.

### Decision required

Select the embedded SQLite implementation here, with explicit migration files and transaction support. Do not let individual streams choose persistence technologies independently.

### Exit criterion

A reviewed, versioned contract baseline exists. No Gallery route layer is copied; Gallery is used only to map behaviors and derive conformance cases.

## Stream 1 — Local portable reference instance

This is the highest-value implementation stream and should be prioritized immediately after Stream 0.

### Deliverables

- Create `apps/reference-api`.
  - Versioned `/v1` HTTP API.
  - Consistent error envelope and request IDs.
  - Health, readiness, and dependency diagnostics.
  - Thin transport handlers over application services.
- Create `@ubeeq/adapters-local`.
  - SQLite repositories and migrations.
  - Filesystem object storage and development delivery URLs.
  - Local password-capable identity provider with local-only safeguards.
  - SQLite-backed local job queue.
- Implement the initial application services and endpoints.
  - Creator profiles, Works, Assets, and Collections.
  - Upload initiation/completion and checksum validation.
  - Publication intent and public publication.
  - Delivery issuance.
  - Authenticated creator export generation.
- Add the reference end-to-end test:
  - Sign in.
  - Create creator.
  - Upload image.
  - Create and publish Work.
  - Render the Work publicly.
  - Export the creator's portable manifest.

### Exit criterion

One documented local command works without AWS credentials or external services and supports the complete creator-to-public-Work workflow.

## Stream 2 — Durable workflows and safety mechanisms

This stream builds on the local vertical slice without needlessly changing its HTTP contract.

### Deliverables

- Local durable jobs with leases, deduplication, retries, cancellation, dead-letter disposition, recovery actions, and observability records.
- Processing orchestration.
  - Source validation, checksums, metadata extraction, rendition request/result records, and idempotent asset revision publication.
- Moderation execution.
  - Evidence ingestion, holds, review cases, decisions, and immutable audit events.
  - Admission checks before processing, publishing, delivery, and export.
  - Neutral reviewer queue API.
- Complete collection/work membership and publication/reconciliation persistence.
- Operations APIs for failed jobs and interrupted uploads.

### Boundary rule

Ubeeq owns evidence, state transitions, admission mechanics, and auditability. Product extensions decide policy outcomes and user-facing enforcement rules.

### Exit criterion

Interrupted uploads, processing, and import/export jobs can be safely retried with durable audit history.

## Stream 3 — Portability, integrations, and federation

Schema and contract work can begin immediately after Stream 0. Runtime integration follows Stream 1's repository composition.

### Deliverables

- Create `@ubeeq/portability`.
  - Versioned creator-export schema.
  - Secret-exclusion validation.
  - Import planning, checkpoints, dry runs, conflicts, and round-trip tests.
- Complete integration runtime contracts in `@ubeeq/integrations`.
  - OAuth state/callback contracts.
  - Credential-vault port; plaintext credentials must never enter exports or logs.
  - Account health, cursors, rate-limit/retry classification, reconciliation, and remote deletion.
  - Real application-service conformance fixtures.
- Create one optional reference connector package, rather than embedding a connector in core.
- Implement the federation protocol.
  - Instance discovery/capability document.
  - Signed instance and actor identity.
  - Immutable remote publication references, replay protection, withdrawal/update events, and audit records.
  - Policy-extension allow/warn/deny decisions.

### Exit criterion

Creator export/import round-trips successfully; a connector can be installed without core changes; two instances can exchange a replay-safe approved publication reference.

## Stream 4 — Reference UI and generic self-hosting

This stream consumes the stable Stream 1 API. It must not create backend behavior directly.

### Deliverables

- Replace the minimal web reference with a deliberately unbranded creator/public workspace.
  - Profile, Works, Assets, Collections, publication controls, integrations, and exports.
- Replace the placeholder admin reference with operations/reviewer screens.
  - Holds, reviews, job recovery, and diagnostics.
- Keep `@ubeeq/ui` limited to accessible, unbranded primitives and tokens.
- Create `examples/compose-self-host`.
  - API, local worker, SQLite volume, and filesystem object-store volume.
  - Environment/configuration reference, backup/restore guidance, and local identity setup.
- Document product-neutral screenshots and operating guidance.

### Exit criterion

A self-hoster can use the main workflow through the UI without the reference application becoming a hidden hosted product.

## Stream 5 — Optional AWS implementation

Start source assessment early, but defer implementation until the local contracts and durable workflows are passing.

### Deliverables

- Rename or move `@ubeeq/self-host-infra` to `@ubeeq/aws-self-host-infra` or `examples/aws-self-host`.
- Create `@ubeeq/adapters-aws`.
  - DynamoDB repositories.
  - S3 storage and optional CloudFront delivery.
  - SQS/EventBridge durable jobs.
  - Cognito identity.
  - Secrets/credential-vault implementation.
- Add a CDK example that composes only public ports and adapters.
- Add local-to-AWS migration tooling and adapter conformance runs.

### Gallery extraction approach

Gallery is a behavioral source only:

1. Map the Gallery implementation to a Ubeeq port.
2. Extract edge cases into tests and conformance fixtures.
3. Implement a provider adapter behind the port.
4. Run the same conformance and end-to-end suites as the local composition.

Do not move Gallery's monolithic route layer or hosted-product decisions into Ubeeq.

### Exit criterion

Local and AWS compositions run the same reference API tests, while core and application services remain free of cloud SDK imports.

## Coordination rules

- Stream 0 owns public interface changes. Other streams may propose contracts but must not merge competing port definitions.
- Every port change requires type-level contracts, at least one local implementation, and documented concurrency, transaction, pagination, and idempotency semantics.
- Stream 1 owns reference API endpoint conventions and the error envelope.
- Stream 5 cannot add cloud types to core, reference API application services, or local adapters.
- Product names, commercial decisions, hosted-product policy, and branded defaults remain prohibited in public Ubeeq.

## Delivery order

1. Complete Stream 0's contract baseline.
2. Deliver Stream 1's local vertical slice.
3. Run Streams 2, 3, and 4 in parallel.
4. Complete Stream 5 after durable local contracts stabilize.

The first implementation milestone should be deliberately narrow: reference API, SQLite, filesystem storage, local identity, and one image upload/publish/export end-to-end path. This establishes a usable portable center of gravity before adding AWS, integrations, federation, or a large UI surface.
