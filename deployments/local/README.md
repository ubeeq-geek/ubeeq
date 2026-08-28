# Local reference deployment

This profile runs the Ubeeq reference API with `@ubeeq/adapter-local`: SQLite
for durable state, filesystem object storage, local development identity, and
the SQLite-backed job worker. It needs no cloud account or external service.

From the repository root:

```sh
npm run dev:reference-api
```

The reference API documents its local configuration and endpoints at startup.
This directory is a composition profile rather than a separately published
package; reusable local provider implementations live in `adapters/local`.
