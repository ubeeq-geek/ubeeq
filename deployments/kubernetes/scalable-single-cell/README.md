# Kubernetes scalable single-cell

This provider-neutral deployment runs one authoritative Ubeeq cell on
Kubernetes. API pods and worker pods use the same `@ubeeq/adapter-machine`
composition: PostgreSQL is the regional canonical database, and an
S3-compatible store holds regional originals and renditions.

The manifests deliberately do not create a database, object store, identity
provider, or CDN. Operators bring regional managed or self-operated services
that satisfy the Ubeeq ports. That keeps the profile compatible with multiple
Kubernetes distributions and prevents an implicit hyperscaler dependency.

## Deploy

1. Build and publish an image containing the Ubeeq workspace. Set it in
   `kustomization.yaml`; the image must expose
   `apps/reference-api/dist/machine-server.js` and `machine-worker.js`.
2. Copy `secret.example.yaml` outside source control, replace every value, and
   apply it as `ubeeq-cell-runtime`.
3. Set cell identity, public origin, and ingress host in `configmap.yaml`.
   A cell ID/region change creates a different cell; it is never a migration.
4. Apply `kubectl apply -k deployments/kubernetes/scalable-single-cell`.
5. Confirm `/health` and `/ready`, run an upload/publish/export smoke flow, and
   test database and object-store restore before accepting creator data.

The ingress is intentionally generic. Terminate TLS with the selected ingress
controller, keep PostgreSQL and object storage private, and configure the
object-store endpoint as browser-routable only if enabling
`UBEEQ_S3_DIRECT_UPLOADS=true` with restrictive CORS. The default proxy-upload
mode keeps it private.

This is one regional cell, not a multi-cell control plane: it performs no
cross-region replication or automatic write failover. Use the managed routing
and migration contracts for explicit movement between cells.
