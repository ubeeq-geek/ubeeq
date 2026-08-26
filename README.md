# Ubeeq

Ubeeq is a brand-neutral, self-hostable platform for creator work, assets, integrations, delivery, and extension-based product composition.

Hosted products consume Ubeeq through versioned packages and extension contracts. This repository intentionally contains no hosted-product branding, pricing, policy decisions, credentials, or operational runbooks.

## Packages

- `@ubeeq/core` — neutral domain entities and lifecycle contracts.
- `@ubeeq/extension-sdk` — versioned extension manifests and product-policy interfaces.
- `@ubeeq/api` — startup validation for extension compatibility.
- `apps/web-reference` and `apps/admin-reference` — minimal neutral composition examples.

## Extension compatibility

Extensions declare an API version and the contracts they implement. `@ubeeq/api` validates manifests at startup and fails clearly if a required extension is missing or incompatible. See [`packages/extension-sdk`](packages/extension-sdk) for the initial contracts.

The SDK also defines platform-neutral integration capabilities, such as metadata import, work publication, activity synchronization, and remote deletion. A product decides whether and how a compatible connector is offered.

## Repository boundary

Public Ubeeq code may provide reusable mechanisms such as storage, processing, audit, authorization hooks, federation protocols, and integration lifecycle contracts. Product policy, branding, commercial plans, discovery decisions, operational procedures, and credentials belong in private product repositories.
