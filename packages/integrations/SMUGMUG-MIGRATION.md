# Shared SmugMug workflow

`@ubeeq/integrations` exports `SmugMugIntegrationService`, its connection,
migration, item and repository contracts, checkpoint validators, and the
`InMemorySmugMugRepository` reference implementation alongside the HTTP gateway.
The workflow owns OAuth claims, request-bound inventories and completion receipts,
bounded metadata summaries, migration initialization, item checkpoints and source
quality/checksum handling. Existing state shapes and request identifiers are
preserved by the extraction.

Applications supply the gateway/vault configuration, repository, content sink,
optional outbound source and `canManageCreator(userId, creatorId)` admission port.
Admission defaults to deny. No role hierarchy, product content catalogue, scanner
thresholds, cloud configuration or credential values are built into this module.
The sink owns actual content writes and quarantine decisions. Import/inventory do
not invoke provider mutations; optional selected-publication/metadata-update
methods are separate explicit operations, not automatic follow-up steps.

One inventory call advances at most one gateway page and bounded summary reads.
Migration initialization reads up to 100 images per call; processing handles up
to 10 saved items per call. Applications must schedule continuation and enforce
worker lifetimes. A gateway page can itself contain multiple HTTP requests; these
service bounds do not establish a total network/CPU deadline.

The in-memory repository supports cloned checkpoints and synchronous persistence
callbacks, not database durability or multi-process concurrency. A callback failure
propagates but does not roll back installed in-memory state. Durable adapters must
implement the declared compare-and-swap and atomic completion contracts. Credentials
and checkpoints must remain private to the consuming application.

Remaining qualifications include durable provider adapters, worker/side-effect
fencing, bounded sink lookups, outbound reconciliation and stronger concurrent
revocation/connection transitions. Moving the code does not resolve those issues.
Tests exercise the public package with synthetic gateways and sinks; live provider
and cloud acceptance remain separate.
