# Durable job adapter qualification

Claiming a job increments its execution attempt. Reporting a retry does not
increment it again; a retry at the configured attempt budget dead-letters the job.
The shared queue contract checks claim/retry accounting for local and AWS adapters.
Invalid lease duration or blank cell input rejects before querying. A competing
revision returns no lease; infrastructure failures propagate to the caller instead
of being reported as an empty queue.

These checks are mocked adapter qualification, not live deployment acceptance.
Expired-lease recovery, expiry enforcement at state transitions, bounded
cell-specific candidate discovery, notification reconciliation and atomic fencing
of job-dependent content writes remain separate requirements. Existing historical
AWS attempt counts are not rewritten; jobs leased under older code may retain the
older attempt convention until explicitly reconciled. No backfill runs implicitly.
