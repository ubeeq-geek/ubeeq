# Public derivative publication workflow

`publishPublicDerivative` owns deterministic publication identity, isolated
destination keys, conditional claims, copy/completion sequencing, read-only
receipt recovery and failure fencing before cleanup. Repository and storage
ports are injected; AWS implementations are available separately.

Publication is denied unless the admission callback explicitly returns true.
Products own policy, entitlement, authoritative version checks and configured
bucket boundaries. The workflow snapshots input before asynchronous admission
and supplies the callback a separate copy. No product catalogue or policy rules
are embedded. A derivative location is not proof of its content or provenance.

Completed receipts can recover duplicate claims or lost responses without
repeating storage effects. Repository failure must conditionally exclude
completion before cleanup is allowed. These contracts do not implement general
reconciliation, cancel in-flight storage writes, or revoke cached bytes.
Source keys must be immutable; supplied hashes are not byte verification.
Existing publication identities/key layouts are preserved. Tests use neutral
in-memory fixtures, not live providers or a production-readiness audit.
