# Publication reconciliation loop

runPublicationReconciliation advances at most 100 evaluated repository steps per
invocation. Each publication attempt precedes its compare-and-swap checkpoint.
Item failures are counted and revisited on a later sweep; repository/checkpoint
failures propagate. Checkpoint contention stops the invocation. A continuation
callback lets a worker reserve time before the next step.

Applications supply durable cursor storage, provider reconciliation and scheduling.
This loop does not authorize publication, bound a provider call's duration, lease
external effects, or guarantee exactly-once processing. A crash before checkpoint
may repeat an attempt; callers must make reconciliation replay-safe.
