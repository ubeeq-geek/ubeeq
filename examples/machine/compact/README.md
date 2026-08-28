# Compact machine deployment example

This cloud-free compact-machine example runs the neutral reference API, an autonomous durable-job worker, creator workspace, and operations workspace with SQLite and filesystem object storage in a named Docker volume. Caddy provides the public TLS edge. It requires neither AWS credentials nor hosted-product modules.

Copy the configuration template, set a real DNS name which resolves to this machine, and generate a distinct long credential-encryption key:

```sh
cp .env.example .env
${EDITOR:-vi} .env
```

From this directory, run:

```sh
docker compose up --build
```

Open the creator workspace at `https://${UBEEQ_PUBLIC_HOST}`, operations at `https://admin.${UBEEQ_PUBLIC_HOST}`, and API health at `https://${UBEEQ_PUBLIC_HOST}/api/health`. Caddy obtains and renews public TLS certificates; allow inbound TCP 80 and 443 and keep all application ports private.

The `ubeeq-data` volume is durable state. Back it up before upgrades with `./backup.sh /secure/backup/location`; retain the archive and its SHA-256 checksum in encrypted off-site storage. Restore only into an instance using a compatible Ubeeq release with `./restore.sh /secure/backup/location/ubeeq-compact-*.tar.gz`. Test both procedures before accepting creator data.

The Compose file declares one explicit data home. Change `UBEEQ_CELL_ID`, `UBEEQ_CELL_REGION`, and `UBEEQ_CELL_OPERATOR` together only when creating a separate deployment, never as a way to move existing data. This is a **compact**, single-machine profile: SQLite, filesystem storage, and the single worker are intentionally not the horizontally scalable PostgreSQL/S3-compatible deployment. That will live under `deployments/machine/scalable-single-cell` and use the same Ubeeq ports.

Validate the manifest without starting containers with `npm run test:machine-compact`. Set `RUN_MACHINE_COMPACT_SMOKE=1` to build the containers, wait for service health, probe the public edge, and clean them up.
