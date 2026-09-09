# Automatic retry budgets

Claims count execution attempts. Reporting failure does not increment that count.
`retry` schedules another attempt only while the claimed job is below
`maxAttempts`; otherwise it dead-letters the job and retains the reported error.
Both outcomes release the lease. Completion on the last allowed attempt remains
valid. SQLite and PostgreSQL decide this in the same conditional write that checks
the lease, rather than using a separate read followed by an unconditional update.
PostgreSQL acknowledgements also require a lease that has not expired according
to the database clock.

Explicit `recover` remains a caller-authorized operation: it preserves cumulative
attempt count and allows a new claim. A subsequent failure at or above the budget
dead-letters again. This change does not revive or rewrite existing jobs.

The shared queue contract checks two failures, retained counts and errors, and no
automatic claim after exhaustion. SQLite adds real restart and stale-token tests.
PostgreSQL command tests verify the conditional SQL; the optional database contract
requires a dedicated test database and is not evidence of live qualification when
skipped. PostgreSQL crash recovery still needs bounded expired-lease accounting;
AWS still needs cell/due-work discovery beyond its first repository page.
Queue acknowledgement is not an atomic fence around a worker's external effects.
