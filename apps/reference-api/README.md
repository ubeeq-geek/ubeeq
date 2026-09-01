# Ubeeq reference API

The reference API is a neutral, local-first implementation of the creator profile, Work, Asset, Collection, upload, publication, delivery, and export flow.

Upload completion creates a durable `asset.process` job instead of making an asset immediately publishable. For the local reference composition, run one queued job with `POST /v1/operations/jobs/run-next` using a signed-in session. The same operations surface exposes queued-job recovery/cancellation, neutral moderation holds, and review cases. A hosted product must supply its own authorization and review policy before exposing those operations to users.

`GET /v1/exports/me` produces the versioned, checksummed creator manifest defined by `@ubeeq/portability`. `POST /v1/imports/validate` performs a no-write validation/conflict check; `POST /v1/imports` defaults to dry-run and imports only when sent with `dryRun: false`. Manifest import deliberately excludes credentials and original files. Imported assets remain pending until a separately authorized object-transfer and processing step supplies their source files.

Run it from the repository root:

```sh
npm run dev:reference-api
```

It listens on `http://127.0.0.1:4100` by default and stores SQLite state plus filesystem objects under `./var/reference`. No cloud credentials or network service are required.

`node:sqlite` is currently experimental in Node 22; use Node 22.5 or newer for
this reference implementation. With nvm, run `nvm install 22 && nvm use 22`.
