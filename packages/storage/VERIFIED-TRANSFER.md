# Verified private object transfer

`transferVerifiedObject` copies one admitted, versioned object to a fresh private
key. It checks source metadata and actual SHA-256/length, requires the writer's
actual provider version, then reads that destination version back and verifies
its metadata and bytes before returning a reference. It returns no delivery URL
and does not update domain records or publish content.

The caller must supply trusted source/destination prefixes and an `admit`
callback that checks current source access, destination ownership, and applicable
policy. Admission runs before source access, before writing, and before returning.
Prefixes and manifest references alone are not authorization. Checks are not an
atomic transaction with external policy changes.

The destination writer must enforce private storage and write only the supplied
fresh key. It must return an actual provider-versioned reference; a randomly
invented S3 version ID is not acceptable. Readback checks cannot substitute for
correct provider access-control configuration.

The default per-object limit is 50 MiB, checked against declared size before
reading and actual bytes afterward. The current storage `get` port buffers the
whole response: this is not a transport-level memory limit. Streaming provider
adapters, aggregate transfer budgets, and durable job checkpoints remain caller
integration work.

Failures return no verified reference. Uncertain writes are deliberately retained;
cleanup and reconciliation belong to the caller. Retrying generates a new key,
not an idempotent resume. A complete restore must separately validate product
fields and conflicts and atomically commit domain references only after all
required objects are verified. This helper alone does not authorize a restore.
