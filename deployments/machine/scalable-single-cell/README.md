# Machine scalable single-cell

This provider-neutral profile is for horizontally scaled API and worker
machines with one authoritative regional database, object store, queue,
identity provider, and backup plan.

`@ubeeq/adapter-machine` now provides PostgreSQL repositories and a
PostgreSQL-backed durable worker queue, plus an S3-compatible storage adapter
that works with MinIO, Ceph RGW, or another compatible regional object store.
The adapter owns the protocol client; Ubeeq core and application services do
not import cloud SDKs.

The next composition increment supplies production OIDC/credential-vault
adapters and a Compose/Kubernetes deployment that wires every required port.
It must run the shared PostgreSQL, queue, storage, identity, and end-to-end
conformance suites before it is treated as a supported profile.
