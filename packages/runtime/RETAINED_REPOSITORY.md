# Retained content repository integration

`RepositoryRetainedContentStore` stores the full retained Work, canonical asset,
attachment, publication, intent, collection, membership, discovery, restore,
source receipt, claim and operation records in the existing `hostRecords`
repository. Each business record has one storage row; its business identifiers
and opaque fields are preserved. Preparation commands and auxiliary host records
join the same transaction rather than using a separate content database.

The inherited memory domain engine is only a private transaction view. There is
no process cache, editable snapshot file, compact Work copy or second queue.
Reads capture a complete guarded repository inventory; writes coalesce changed
records and update the Creator cohort inventory atomically. Missing cohort data
requires migration. Missing inventory rows require reconciliation. Neither case
is presented as an empty Creator.

The server must supply actual transactional actor resolution and source-file
validation. Commercial hosts must also supply their enclosing transaction runner
so their membership guard registry lives until the same database commit. Mutations
require an actor accepted inside that scope. The saved actor remains subject to
the same guard during recovery; a worker identity confers no Creator permission.

`createRetainedRepositoryCreator` creates a new Creator and its empty cohort in
one transaction. The server-owned content composition supplies `createCreator`
when it selects this birth writer; the normal host preparation and activation
lifecycle remains in place. Core validates the actual persisted result against the
admitted ID, actor, profile and data home before preparing receipts. It refuses an
existing Creator, including a revision-one legacy
Creator. `contentAuthority: retained-v1` fences the normal SQLite, PostgreSQL and
Dynamo repository compositions against compact content writes and prevents normal
callers from changing the authority or deleting its Creator. This is an operator
migration boundary, not a profile setting or an HTTP input.

The retained adapter preserves conditional shared-Work revisions, publication
observations, immutable disclosure history and command projection protection.
Image replacement retires the previous attachment only for its Work, preserving
an original still attached elsewhere. The actual host validates original source
and access evidence inside the accepting transaction.

## Current integration boundary

This adapter is not the default product factory. No existing Creator is migrated
or switched by installing it. Complete retained source, organization, metadata,
provider and browser composition must still be connected before activation.
Compact list/export endpoints return an accurate unavailable error for a retained
Creator until its retained routes are mounted; they never export or display an
invented empty history. This is a staging boundary, not completed route compatibility.
All generic and operator writers, including older binaries, must be quiesced for
an existing-Creator migration; do not switch the authority while they run. Reusing
a deleted legacy Creator ID requires inventory reconciliation, not the birth path.

The adapter currently materializes the complete repository inventory and uses a
coarse mutation fence. Unrelated writes can conflict. Individual retained payloads
are limited to 300 KiB; Dynamo's 100-item transaction budget includes the cohort,
repository fence and Creator/member guards. Logical batch limits do not override
that physical budget. Large records, large restores, paged discovery and managed
load acceptance remain required before full product readiness. A rejected batch
has no partial durable effect.

## Validation

Local tests cover reopen, unchanged rich records and IDs, current actor and tenant
checks, missing legacy cohorts, compact-writer fencing, shared metadata CAS,
per-Work image retirement, source evidence, observation and missing inventory.
The actual HTTP/worker test interrupts after durable preparation acceptance,
closes and reopens the SQLite host, and resumes the article under its saved actor.
The managed suite uses actual disposable DynamoDB tables for repeated guard
coalescing, incompatible guards, guarded writes, revocation at commit and the
physical transaction budget. No media or publication provider is simulated as a
successful integration by these tests.
