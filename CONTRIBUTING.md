# Contributing to Ubeeq

Thank you for helping improve Ubeeq. This repository is an open, brand-neutral, self-hostable core; hosted-product branding, pricing, editorial policy, credentials, and operational configuration belong in downstream repositories.

## Before starting

- Search existing issues and pull requests before opening duplicate work.
- For a large feature, persisted-format change, or exported contract change, open an issue first so scope and compatibility can be agreed.
- Report vulnerabilities through the process in [SECURITY.md](SECURITY.md), not a public issue.
- Read [AGENTS.md](AGENTS.md) for the repository's architectural, safety, and validation constraints. They apply whether a change is authored manually or with automation.

## Local setup

Ubeeq requires Node.js 22.5 or newer.

```sh
nvm install 22
nvm use 22
npm ci
```

The reference applications use local SQLite, filesystem storage, local sessions, and a local durable queue. Normal development and tests must not require cloud credentials or live provider access.

## Making a change

- Work on a focused branch and keep unrelated changes out of the pull request.
- Preserve the boundaries among packages, adapters, deployments, and reference applications.
- Keep public packages brand-neutral and localization-ready.
- Treat exported types, package entry points, manifests, schemas, and persisted formats as compatibility contracts.
- Add or update tests for changed behavior, including failure and retry paths where relevant.
- Do not commit credentials, local state, generated deployment output, media, or production data.
- Do not use tests to call live providers, spend money, or mutate production resources.

## Validation

Run focused tests while iterating. Before requesting review, run:

```sh
npm run build
npm test
```

Also run the relevant checks for the change:

- Public package boundaries: `npm run check:public-boundary`
- Adapter contracts: `npm run check:adapter-contracts`
- Publish contents or exports: `npm run pack:verify`
- License inventory: `npm run check:licenses`
- Deployment, commerce, website preview, or machine profiles: the matching smoke or browser command from `package.json`

If a required external qualification is unavailable, say so explicitly in the pull request and describe the remaining operator step.

## Pull requests

Use the pull-request template and explain:

- the problem and resulting behavior;
- compatibility, persistence, authorization, security, and downstream effects;
- validation performed and any qualification still outstanding;
- migration or rollback considerations when applicable.

A pull request does not authorize publishing packages, deploying infrastructure, spending funds, calling live providers, or changing production data.
