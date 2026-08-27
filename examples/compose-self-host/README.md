# Ubeeq Compose self-hosting example

This cloud-free example runs the neutral reference API, creator workspace, and operations workspace with SQLite and filesystem object storage in a named Docker volume. It requires neither AWS credentials nor hosted-product modules.

From this directory, run:

```sh
docker compose up --build
```

Open the creator workspace at `http://localhost:4173`, operations at `http://localhost:4174`, and the API health endpoint at `http://localhost:4100/health`.

The `ubeeq-data` volume is durable state. Back it up before upgrades, and restore it only into an instance using a compatible Ubeeq release. The Compose file declares one explicit `local-single-cell` data home; change `UBEEQ_CELL_ID`, `UBEEQ_CELL_REGION`, and `UBEEQ_CELL_OPERATOR` together only when creating a separate deployment, never as a way to move existing data. This is a compact local reference deployment: replace the local identity, SQLite/filesystem adapters, and single-node worker with production-capable adapters as required by your own operation.
