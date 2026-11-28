# Rust customer-scope claims Lambda

This ports the Cognito V2/V3 pre-token trigger. It preserves unrelated delegate
output and checks the configured user pool and client before invoking an optional
immutable Lambda version. A conflicting scope claim or subject fails issuance.

Run `cargo test --locked` here with Rust 1.100.0. The Rust customer scope claims
workflow builds on Amazon Linux 2023 and produces an x86-64 ZIP containing the
executable `bootstrap` at its root. It does not publish or deploy the ZIP.

Use `ClaimsImplementation=rust` with that versioned ZIP when reviewing a
development deployment of `deploy/customer-account-runtime.template.json`.
Use the same pool, client IDs, and immutable optional delegate configuration as
the Node trigger. Qualify both Cognito pre-token event versions and delegation
before wiring this function to a user pool.
