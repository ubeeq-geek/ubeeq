# Ubeeq

Ubeeq is a brand-neutral, self-hostable platform for creator work, assets, integrations, delivery, and extension-based product composition.

Hosted products consume Ubeeq through versioned packages and extension contracts. This repository intentionally contains no hosted-product branding, pricing, policy decisions, credentials, or operational runbooks.

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
- `@ubeeq/federation` — remote actor and publication-reference contracts.
- `@ubeeq/self-host` — neutral self-host instance configuration validation and reference configuration.
- `@ubeeq/deployment-platform` — versioned deployment-artifact provenance and regional rollout contracts.
- `@ubeeq/api` — startup validation for extension compatibility.
- `apps/web-reference` and `apps/admin-reference` — minimal neutral composition examples.

## Extension compatibility

Extensions declare an API version and the contracts they implement. `@ubeeq/api` validates manifests at startup and fails clearly if a required extension is missing or incompatible. See [`packages/extension-sdk`](packages/extension-sdk) for the initial contracts.

The SDK also defines platform-neutral integration capabilities, such as metadata import, work publication, activity synchronization, and remote deletion. A product decides whether and how a compatible connector is offered.

## Repository boundary

Public Ubeeq code may provide reusable mechanisms such as storage, processing, audit, authorization hooks, federation protocols, and integration lifecycle contracts. Product policy, branding, commercial plans, discovery decisions, operational procedures, and credentials belong in private product repositories.

## Self-hosting reference configuration

[`packages/self-host/reference-config.json`](packages/self-host/reference-config.json) is a product-neutral starting point. Replace its example origin and local storage path, provide any desired extension manifests, and validate the resulting configuration with `@ubeeq/self-host`. It contains neither hosted product settings nor credentials.
