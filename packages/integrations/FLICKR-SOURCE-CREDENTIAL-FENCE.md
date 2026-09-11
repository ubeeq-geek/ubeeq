# Source batch credential fence

FlickrSourceWorkflow snapshots the connection at batch start and includes its
encrypted token reference in subsequent admission comparisons. Replacing that
reference during transfer or quarantine scanning aborts before attachment; a
change during attachment prevents the final migration checkpoint. The callback
receives a detached connection so it cannot mutate the expected fence.

Admission errors abort the batch rather than becoming ordinary transfer failures
or being recorded as successful migration progress. Credential values are not
included in error text or audit details. Ports must still enforce authorization
and identity atomically at their own writes: a final admission failure cannot
undo an attachment already committed by a port.

This is a within-batch fence, not persisted confirmation-to-credential binding.
A new batch captures the then-current credential reference. Products that require
fresh consent after reconnect must bind and validate that across confirmation,
checkpoints and retries. It also does not cancel already issued network requests
or replace cross-process leases and atomic checkpoint guards.
