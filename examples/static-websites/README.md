# Native static website export example

Run `npm run build` at the repository root, then:

```sh
node examples/static-websites/export.mjs
```

The example creates an isolated temporary directory containing `site/`, a
portable `website.zip`, and a separate private validation/dependency report.
Serve `site/` using any static HTTP server with directory index support. Ubeeq
does not need to be running. The demonstration includes Home, About, a sub-page,
a public local gallery, bundled metadata-clean JPEG and a portable redirect link.

This fixture has no private content. Application requests must use the authorized
`WebsiteService` workflow documented in
[Native static websites](../../docs/native-static-websites.md); the pure artifact
builder does not resolve membership or approve content by itself.
