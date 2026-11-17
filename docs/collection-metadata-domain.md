# Collection metadata domain

`@ubeeq/core` exports the retained metadata-only contracts and planning logic under
the `collectionMetadata` namespace. They cover title, description and saved cover
references. They do not grant access, alter collection membership/order, publish
Works, or write remote destinations.

The module has no Node imports. Trusted server composition supplies actual
SHA-256 over UTF-8, unique IDs and its clock:

```ts
import {createHash, randomUUID} from 'node:crypto';
import {collectionMetadata} from '@ubeeq/core';

const domain = collectionMetadata.createMetadataDomain({
  sha256Hex: text => createHash('sha256').update(text, 'utf8').digest('hex'),
  createId: randomUUID,
  now: () => new Date().toISOString(),
});
```

Crypto/clock/ID ports come from composition, never request data. There is no weak
default hashing implementation. Types and structural helpers remain safe to
bundle for browser use; hash-dependent planning requires the explicit ports.

## Compatibility

Keep existing serialized records, IDs, endpoint identities, field hashes, proposal
keys and published projections. Hashing preserves the retained stable JSON
ordering, Unicode normalization, line ending behavior, empty/null description
equivalence and cover timestamp handling. Platform description projection retains
paragraph terminators; trimming those values would invalidate stored baselines.
Six golden vectors captured from the retained native implementation verify the
persisted hash format.

`MetadataCollectionRecord` is a structural boundary. Generic catalogue updates
preserve the caller's URL, visibility, ordered Works, publication history and
opaque fields. Their first edit retains the independent public metadata
projection. Existing native compatibility modules can retain their original
exports while binding the shared factory to server cryptography. Saved cover
formats have one shared type owner: `collection_2x`, `collection_1x`, and `profile`.

Unknown or unavailable observations never instruct a clear. Explicit clearing
still requires destination capabilities. Initial automatic changes need their
accepted baseline; direct destination edits and changed native baselines remain
conflicts. A SOURCE retains field authority while paused until it is detached.
Graph reservations preserve destination writer uniqueness and reject cycles.

## Host obligations

Planning is not mutation authorization. Before effects, the retained service and
adapters must enforce current actor/account permissions, Creator ownership and
cell, active configuration, current capabilities and policy, exact-value review,
fresh observations, conditional remote writes, and publication/admission rules.
Cover references need actual asset custody or validated provider ownership; the
structural cover schema does not authorize object reads or URL fetches.

Persistence must atomically compare catalogue/configuration/graph revisions and
current authority, retain immutable snapshot history, and record idempotent
commands, outcomes and audit events. The route graph must cover every writer
sharing its destination claims. Partitioning those claims by Creator would lose
the retained uniqueness protection. Bind leases, retries, remote reconciliation
and worker recovery through the retained service rather than treating a PENDING
proposal as permission to write.

This module does not initialize or adopt old libraries on read. Existing state
and graph data need explicit migration and writer coordination. Moving the domain
alone does not certify the shared HTTP, remote-provider, browser or migration
workflow.

## Verification

Core tests cover golden hashes, unavailable observations, safe patch boundaries,
independent public projections, preserved opaque catalogue fields, source field
authority, conflict/clearing/initial-review rules, writer/cycle reservations, and
commit revision/ownership contracts. The retained native route and persistence
tests also run through a compatibility binding; their existing guarded store and
provider behavior remain in place while those adapters are extracted separately.
