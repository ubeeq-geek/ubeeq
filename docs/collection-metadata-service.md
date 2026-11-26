# Shared collection metadata service

`collectionMetadataService.createMetadataService` owns the retained metadata
relationship state machine. It uses the existing `collectionMetadata` domain,
preserving stored hashes, snapshots, proposals, baselines, execution receipts and
the separation between editable catalogue values and published representations.
It has no Work membership, ordering, access, upload or content publishing methods.

The factory requires explicit host ports for the current runtime's tenant,
feature flag, management authority, authorization receipts, graph reads,
metadata-only adapters, destination admission and legacy relationship discovery.
There are no permission or publication defaults. Host-specific account lookup,
credential refresh, current membership and platform-role checks remain in their
established adapters. A collection-specific domain update preserves the host's
opaque fields and concrete record type without a type assertion.

The service operates on a private working copy. **Its returned graph and state
are not a commit or permission to publish.** Hosts must authorize every route,
hold the existing collection lease, and conditionally commit collection,
metadata, graph, organization and all recorded actor permissions together. A
failed operation may have changed the working copy; discard it. Do not persist a
partial draft after an error. Every installation writer must share the existing
graph fence, including writers from another tenant in the same installation.

Related-only discovery does not read remote values or fabricate provenance,
source authority or automation. SOURCE fields retain their existing native edit
restrictions. Exact reviewed native values, configuration, remote observations
and adapter revisions must match at application. Partial approval records only
accepted fields; continuation keeps its reviewed hashes. Automatic updates need
an explicit initial review and activation. Pending incoming values never reach
destinations. An unavailable destination retains its own attention/audit state
without discarding another successful destination or accepted native values.

Outgoing metadata still requires the host's current publication/release and
admission checks. Private asset and arbitrary remote cover references cannot be
promoted into public URLs. No external provider write, public release, visibility
change or new publication is implemented by this service.

The native compatibility binding retains the current authorization, publication
and legacy lookup adapters, plus the existing HTTP lease/idempotency and guarded
in-memory/DynamoDB commits. The shared service does not adopt legacy runtime
libraries or expose new managed routes. Full shared persistence, worker, product
browser and explicit adoption integration remain separate release gates.

The unit suite exercises port denial, exact review, partial acceptance, explicit
Automatic setup, offline ownership changes, private cover rejection and isolated
fanout. The unchanged native metadata domain, route and persistence suites verify
the actual compatibility binding. These local checks do not certify deployed
identity, real provider transport or a production migration.
