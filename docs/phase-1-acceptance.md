# Phase 1 acceptance matrix

Phase 1 is complete when the following checks pass on Node.js 22 or newer. Provider-live suites remain opt-in, but every adapter must pass the provider-neutral contract listed here.

| Boundary | Executable evidence |
|---|---|
| Creator data home is explicit | `packages/core/test/content-availability.test.mjs`, `packages/api/test/composition.test.mjs` |
| Canonical repository operations are cell-local | `verifyCellScopedRepositoryContract`, run by local and AWS adapter tests |
| Durable jobs are cell-local | `verifyJobQueueContract`, `packages/jobs/test/cell-routing.test.mjs` |
| Credentials are cell-local | `verifyCredentialVaultContract`, local and AWS credential tests |
| Upload acceptance/completion is creator- and cell-local | `verifyUploadContentAdapterContract`, AWS direct-upload tests |
| Public delivery uses signed rendition-only claims | local delivery contract and reference API E2E cache assertions |
| Portable exports reject secrets, dangling references, duplicates, and mixed cells | `packages/portability/test/contracts.test.mjs` |
| Operational moderation data is cell-local | reference API E2E operational endpoint assertions |
| Core/application packages contain no cloud SDK imports | `npm run check:public-boundary` |
| Complete Phase 1 build | `npm run build` |

The normal upload path writes only the configured cell's storage and queue. Phase 1 does not provide cross-region failover, background migration, or live replication; those behaviors must not be inferred from passing this matrix.
