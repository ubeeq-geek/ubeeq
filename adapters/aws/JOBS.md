# Durable job adapter qualification

Claiming a job increments its execution attempt. Reporting a retry does not
increment it again; a retry at the configured attempt budget dead-letters the job.
The shared queue contract checks claim/retry accounting for local and AWS adapters.
Invalid lease duration or blank cell input rejects before querying. A competing
revision returns no lease; infrastructure failures propagate to the caller instead
of being reported as an empty queue.

These checks are mocked adapter qualification, not live deployment acceptance.
Bounded cell-specific candidate discovery, notification reconciliation and atomic fencing
of job-dependent content writes remain separate requirements. Existing historical
AWS attempt counts are not rewritten; jobs leased under older code may retain the
older attempt convention until explicitly reconciled. No backfill runs implicitly.

Complete, retry and dead-letter operations now reject missing, malformed or expired
leases before writing. Their DynamoDB transition also conditions on revision,
leased state, owner token and stored expiry later than the supplied current UTC
timestamp. State changes clear the expiry. The condition protects against changed
lease state between the read and write; it is not a database-generated clock or a
fence on external effects. Clock skew, requests delayed after timestamp capture,
job-dependent content transactions still require qualification.

Lease acquisition now recognizes expired jobs in its bounded candidate page. It
conditionally reclaims them with a new token and incremented attempt, or marks
them dead-lettered when the expired attempt exhausted the budget. Every claim
checks revision, cell, state and due/expiry timestamp in the write. Other cells,
excluded types, active leases and malformed expiries are not reclaimed.

Discovery still reads only the first 100 records from the repository-wide index;
eligible work beyond that page may be starved. This is not complete queue liveness
qualification: a cell/due-work access pattern and recovery scheduling remain needed.
Malformed and historical attempt records require explicit qualification, not an
implicit repair. No live AWS acceptance or data backfill is implied by mock tests.
