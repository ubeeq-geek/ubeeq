# Security policy

## Supported versions

Ubeeq is currently under pre-release development. Security fixes are applied to the current `main` branch. Older commits, forks, and downstream deployments are not maintained directly by this repository and should update to a reviewed fix when one is available.

## Reporting a vulnerability

Do not open a public issue, discussion, or pull request containing an undisclosed vulnerability, exploit, credential, customer data, or other sensitive evidence.

Use GitHub's private vulnerability reporting for this repository. If the private reporting option is unavailable, open a public issue containing only a request for a private contact channel; do not include technical details.

Include, when possible:

- the affected package, adapter, deployment profile, or commit;
- the impact and the conditions required to reproduce it;
- minimal reproduction steps or a proof of concept with secrets and personal data removed;
- whether the issue affects self-hosted deployments, published packages, or a downstream integration;
- any known mitigation.

Please allow maintainers time to investigate before public disclosure. Maintainers will coordinate disclosure and credit with the reporter when practical.

## Scope and safe research

Good-faith reports about authorization boundaries, tenant or Creator isolation, credential handling, persisted data, package provenance, provider callbacks, media delivery, or deployment templates are welcome.

Do not:

- access data or accounts you do not own or have explicit permission to test;
- target hosted products or production systems through this repository's process;
- degrade service, send spam, incur charges, or call third-party providers without authorization;
- publish sensitive details before a fix or coordinated disclosure.

For non-security defects, use the regular GitHub issue tracker.
