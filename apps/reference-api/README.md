# Ubeeq reference API

The reference API is a neutral, local-first implementation of the creator profile, Work, Asset, Collection, upload, publication, delivery, and export flow.

Run it from the repository root:

```sh
npm run dev:reference-api
```

It listens on `http://127.0.0.1:4100` by default and stores SQLite state plus filesystem objects under `./var/reference`. No cloud credentials or network service are required.

`node:sqlite` is currently experimental in Node 22; use the repository's supported Node 22 runtime for this reference implementation.
