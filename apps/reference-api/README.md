# Ubeeq reference API

The reference API is a neutral, local-first implementation of the creator profile, Work, Asset, Collection, upload, publication, delivery, and export flow.

Publication writes the intent, live publication, Work revision and audit record in
one repository transaction. Local failure-injection tests verify rollback at each
later write boundary. This is not full publication qualification: repeated request
idempotency, complete paginated asset/admission checks, concurrent policy changes,
and withdrawal/revocation of issued delivery URLs still need work. The destination
field is metadata here, not confirmation of delivery to an external provider.

These routes use the canonical `repositories.works/assets/publications` records.
They do not automatically consume `LocalCreatorLibraryStore` compatibility records.
A consumer using that library needs an explicit, identity-preserving publication
integration; mounting this route alone does not publish its library Works.

Upload completion creates a durable `asset.process` job instead of making an asset immediately publishable. The entire `/v1/operations` namespace, including queued-job execution/recovery/cancellation, moderation holds, review cases, audit and usage reads, requires explicit `operatorAuthorization` in the API composition. Missing or empty requirements disable these routes with `404 operations_unavailable`; an ordinary signed-in session is not operator authority. Configure a non-empty role/scope requirement and have the identity adapter issue those claims only to authorized operators. Product-specific review policy remains a separate requirement. Trusted in-process worker execution does not use this HTTP boundary.

`GET /v1/exports/me` produces the versioned, checksummed creator manifest defined by `@ubeeq/portability`. `POST /v1/imports/validate` performs a no-write validation/conflict check; `POST /v1/imports` defaults to dry-run and imports only when sent with `dryRun: false`. Manifest import deliberately excludes credentials and original files. Imported assets remain pending until a separately authorized object-transfer and processing step supplies their source files.

Run it from the repository root:

```sh
npm run dev:reference-api
```

It listens on `http://127.0.0.1:4100` by default and stores SQLite state plus filesystem objects under `./var/reference`. No cloud credentials or network service are required.

`node:sqlite` is currently experimental in Node 22; use Node 22.5 or newer for
this reference implementation. With nvm, run `nvm install 22 && nvm use 22`.
