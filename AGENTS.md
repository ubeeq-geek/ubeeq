# Repository scope

- Keep this repository public, brand-neutral, and self-hostable.
- Reusable mechanisms and contracts belong here. Hosted-product branding, pricing, moderation policy choices, discovery rules, credentials, and operational runbooks belong in downstream private repositories.
- Do not import product repositories or copy product-specific behavior into reference applications. Prefer injected policy and adapter interfaces.
- Preserve the boundaries among packages, adapters, deployments, and reference apps. Avoid circular dependencies and convenience imports across layers.

# Change design

- Treat exported types, package entry points, manifests, schemas, and persisted formats as compatibility contracts. Document intentional changes and cover them with contract tests.
- Keep authorization tenant-, Creator-, and cell-scoped. New privileged operations need explicit permission checks and auditable outcomes.
- Production-capable workflows must be durable, idempotent, retry-safe, and explicit about ambiguous provider outcomes. Do not rely on process memory for authoritative state.
- Preserve append-only financial, usage, and audit evidence. Never infer that bytes, credits, or remote side effects disappeared merely because a logical operation failed.
- Tests must not call live providers, spend money, require personal credentials, or mutate production resources.

# User interface

- Use accessible in-app confirmation dialogs for destructive or consequential actions; never use browser-native `confirm` dialogs.
- Name the affected resource, explain the consequence, focus the safe action initially, prevent duplicate submissions, and retain retryable errors in the dialog.
- Keep shared UI unbranded and localization-ready.

# Downstream compatibility

- When changing a published contract, identify affected consumers in `ubeeq-commercial`, `eversally-platform`, `nightframe-platform`, and `brightpush-platform`.
- Do not silently update downstream compatibility pins from this repository. Record the required companion work in the pull request.
- Preserve public-package boundaries with `npm run check:public-boundary`, `npm run check:adapter-contracts`, and `npm run check:publish-workflow` when relevant.

# Validation

- Use Node 22.5 or newer and install with `npm ci`.
- Run focused tests while iterating, then `npm run build` and `npm test` before requesting review.
- Run `npm run pack:verify` when package exports, publish contents, or release workflows change.
- Run the relevant smoke or browser command for deployment, commerce, website-preview, or machine-profile changes; state any unavailable external qualification clearly.

# Agent workflow

- Work on a branch and open a pull request describing the problem, behavior change, compatibility impact, and validation.
- Leave pull requests open for review. Do not merge, deploy, publish packages, start paid resources, or perform production migrations unless the user explicitly asks.
- Never commit credentials, generated deployment output, local state, media, or production data.
