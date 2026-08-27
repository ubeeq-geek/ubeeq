# Neutral web reference

This application is deliberately plain. It provides a local creator workspace for sign-in, profiles, Works, image uploads, local processing, publication, creator export/import, and a public Work response. It demonstrates product composition through `@ubeeq/extension-sdk`; hosted-product visual identity, discovery, pricing, and policy belong in private extensions.

Run `npm run dev:reference-api` in one terminal and `npm run dev:reference` in another. The workspace listens on `http://127.0.0.1:4173` and proxies `/api/*` to `http://127.0.0.1:4100` by default; set `UBEEQ_REFERENCE_API_URL` to use another local API address. It exposes `GET /health`, `GET /extension-contracts`, and has no hosted-product dependency.
