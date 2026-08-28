# Scalable machine single-cell example

This example composes the neutral reference API and worker with PostgreSQL and
MinIO (an S3-compatible object store). It is one regional Ubeeq cell: its
database, objects, jobs, and credentials remain local to the declared cell.

Copy `.env.example` to `.env`, replace every placeholder, point the public and
admin DNS names at the machine, then run:

```sh
docker compose up --build
```

Caddy exposes only ports 80 and 443, obtains TLS certificates, and routes the
creator workspace to `https://${UBEEQ_PUBLIC_HOST}`, operations to
`https://admin.${UBEEQ_PUBLIC_HOST}`, and API requests under `/api`. PostgreSQL
and MinIO are never exposed publicly.

The included composition uses authenticated API upload proxying, which keeps
MinIO private. Set `UBEEQ_S3_DIRECT_UPLOADS=true` only after placing an
S3-compatible endpoint at a browser-routable HTTPS origin with a restrictive
CORS policy for the workspace origin; the client then uses checksum-bound,
short-lived direct PUT URLs.

Use a managed PostgreSQL backup mechanism plus an S3-compatible object-store
backup/replication policy appropriate to the declared data-home region. Test
restore before accepting creator data. This profile does not enable live
cross-region replication; a second region is another Ubeeq cell and migration
is an explicit control-plane operation.

Run `npm run test:machine-scalable` to validate the Compose manifest. In a
Docker-capable CI or operator environment, set `RUN_MACHINE_SCALABLE_SMOKE=1`
to build the stack, wait for health, probe the TLS edge, and remove its test
volumes.
