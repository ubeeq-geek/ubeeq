# Ubeeq Connect — experimental browser extension

A product-neutral browser shell and durable pairing/import service for creator applications. Application codes `UB`, `ES`, `NF`, and `BP` have independent deployment policy. A product supplies its name, application origin, current Creator authorization, and canonical content importer. This is a separate package from the product-composition `@ubeeq/extension-sdk`.

## Implemented scope

- Separate Manifest V3 builds for Chrome/Edge and Firefox, with a toolbar popup plus browser-specific sidebar definitions.
- Five-minute, single-use Creator approvals; hashed, scoped, expiring bearer credentials; revocation; deployment namespace isolation. Website sessions are never exported.
- Explicit optional access to the selected application origin. Source-page inspection uses `activeTab` and a fixed bundled script; there is no general fetch/execute command or remotely supplied script.
- DeviantArt public-gallery proof of concept: first visible page, maximum 50 unique objects, title filter, visible selection, source links, duplicate indication, and selected reference imports. A public author is **not** identified as a signed-in user. The UI requires explicit confirmation of this limitation.
- Durable selected-item jobs, short fenced leases, idempotent job requests, canonical importer fences, checkpoints, cancellation, retries, policy/permission rechecks, and browser restart recovery. An uncertain start request is saved before delivery so Resume can repeat the same request ID.
- WordPress admin discovery (including subdirectory installs) and Tumblr dashboard recognition lead to the product’s existing setup. No provider grant is inferred from discovery.
- Keyboard-accessible confirmation dialog, screen-reader statuses, safe text rendering, dynamic product name, and persistent destination/source context.

Imported media is **external reference only**. The adapter has no original/display-copy transfer, thumbnails, descriptions, tags, collection metadata, source dates, or full-history pagination. Page navigation followed by a new preview is explicit. Unknown dates never match date filters. There is no provider write command or browser publishing capability. Browser work requires the confirmed tab; approved reference imports use the canonical server commit and do not publish.

## Not yet qualified / later stages

This package is a prototype, not a claim that all stages of the connection/import specification are delivered. Keep production availability off until qualification.

- Signed-in DA principal detection and OAuth account validation; official provider-account reuse still belongs to the product’s existing authorization flows.
- WordPress official Application Password approval-and-return and selected canonical historical import. The current extension only discovers the site and opens existing setup.
- Tumblr browser import, blog grants, creator-owned application handoff and browser pagination. Existing product flows remain responsible for creator-owned credentials and quotas.
- DA `editorRaw` publishing, revision/read-back qualification, media transfer and uncertain remote writes. Rich-description readiness is always false.
- Firefox installation/runtime and container mapping, Edge-specific smoke tests, full browser suspension/restart qualification, permission-denial UI, session expiry, and live provider-account/content tests.
- Shared distributed storage adapter, production retention/expiry cleanup, funnel measurements, localization, store signing and publication.

The public-source proof of concept intentionally does not depend on private website APIs or claim an authenticated browser account. It cannot grant unattended API sync or publishing. Public source account names are the currently available scope; this is not a stable authenticated provider-principal ID.

## Build and load

From the Ubeeq repository:

```sh
npm run build:browser-extension
npm run test:browser-extension
```

Chrome/Edge: open the extension manager, enable developer mode, choose **Load unpacked**, and select `packages/browser-extension/dist/chromium`.

Firefox: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `packages/browser-extension/dist/firefox/manifest.json`. The Firefox build targets version 140 or newer. A temporary installation is not signed/store-ready or runtime-qualified.

1. In the application’s Integrations page, select a Creator Identity and explicitly approve a browser connection.
2. Open the extension on that tab. Choose **Use approval from this tab**, verify the application API origin, and **Pair browser**. Manual entry remains available. Permit access only to the intended application.
3. Open a DA public gallery. Choose **Connect this account**, confirm the identified public source and limitations, and preview.
4. Filter/select items, then import references. Keep the browser and confirmed source tab running. Use Resume after reopening the original source if a tab/session was interrupted. Cancellation keeps completed items.
5. Disconnecting revokes only the browser pairing. Imported records and independent OAuth connections remain intact. An authenticated product endpoint can revoke a lost browser by its pairing ID.

## Server composition

Node 22.13+ (or Node 24+) is required for the optional SQLite adapter. The server module loads SQLite only when instantiated. Products may use the exported synchronous atomic `BrowserStore` interface for another storage backend. Do not wrap async transactions in this interface; a distributed implementation needs a separately qualified atomic adapter/transport.

```js
const { BrowserExtensionService, SqliteBrowserStore } = require('@ubeeq/browser-extension');
const service = new BrowserExtensionService({
  store: new SqliteBrowserStore('/persistent/private/browser-extension.sqlite'),
  deploymentId: 'stable-tenant-and-application-origin',
  policy: () => deploymentPolicy,
  authorize: async (userId, creatorId) => currentCreatorManagerAccess(userId, creatorId),
  existing: async (pairing, source, item) => exactCanonicalMappingExists(pairing, source, item),
  importItem: async (pairing, source, item, remoteIdentity, beforeCommit) => {
    // Atomically/idempotently persist canonical Work/Publication + receipt.
    // Recheck beforeCommit immediately before visibility; never overwrite custom metadata.
    return canonicalReferenceImporter(pairing, source, item, remoteIdentity, beforeCommit);
  }
});
```

`policy` consumes normalized server booleans, never environment strings. Only an explicit known application code and boolean true enable availability. The product’s environment parser must accept only literal `true`. Readiness for DA rich publishing remains false even when both settings are true. All content URLs are revalidated against the selected provider/account/object scope; there is no server media fetch in this version.

The browser API consists only of exchange, preview, selected-job creation, bounded step, inspect, pause, retry, cancellation and self-disconnect. The product owns HTTP authentication for issuing/revoking approvals and private/no-store responses. Pairings are scoped to the initiating actor/Creator/deployment/profile; they do not create provider credentials or bypass independent shared-authorization checks. Disabling availability blocks new mutations; a denied step or browser pause releases its lease and preserves checkpoints. No network provider API requests are made by the reference adapter, so it cannot create a second provider request budget.

## Tests and qualification

`npm run test:browser-extension` runs the service/SQLite tests and deterministic adapter/manifest tests. Build artifacts are regenerated before tests.

The optional browser scripts require `playwright-core` plus a locally installed Chromium:

```sh
CHROMIUM_PATH=/path/to/chromium npm run test:chromium --workspace @ubeeq/browser-extension
```

Set `BROWSER_TEST_PLAYWRIGHT` to an absolute `playwright-core/index.mjs` path to use an existing installation. `scripts/smoke-panel.mjs` checks the actual UI modules/CSP in Chromium with mocked extension APIs; it **does not** qualify extension installation or browser permissions.

On 2026-10-27, service and mock adapter checks passed using Node 24.19.0. The managed environment’s Chromium 154.0.8037.57 denied unpacked extension loading with “Loading of unpacked extensions is disabled by the administrator.” That policy was preserved. Firefox and live provider qualification were not performed. Record target-browser versions and live-account approval separately before rollout.
