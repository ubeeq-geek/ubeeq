# Reference Lambda job discovery

The API/worker composition and private cell adapter composition accept the same
explicit environment configuration:

- `UBEEQ_JOB_CELL_DUE_INDEX`: cell/due GSI name.
- `UBEEQ_JOB_CELL_TYPE_DUE_INDEX`: distinct cell/type/due GSI name.
- `UBEEQ_JOB_DISCOVERY_QUALIFIED`: exactly `true`.

All three must be absent to retain legacy discovery. Any partial, empty or invalid
configuration fails initialization; it never silently falls back. Names follow
the adapter's 3–255 character alphanumeric/underscore/hyphen/period constraint.
The API caches its composition per Lambda execution environment; changes require
normal runtime configuration rollout, not mutation of a running application.

The qualification flag is an **operator assertion**, not proof: this code does
not inspect index status, permissions, schema, historical records or index lag.
Complete the [adapter rollout prerequisites](../../adapters/aws/INDEXED-JOB-DISCOVERY.md)
before setting it. Both GSIs must exist and historical active jobs must have
qualified discovery attributes. Otherwise enabling discovery can hide jobs.

No deployment template enables this configuration. This change creates no
indexes, migrates no records and changes no running Lambda configuration.
Infrastructure rollout, historical-data tooling and live qualification remain
separate work. To intentionally restore legacy discovery, remove all three
settings together; its known first-page starvation limitation remains.
