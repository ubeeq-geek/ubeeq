# Durable job adapter qualification

Claiming a job increments its execution attempt. Reporting a retry does not
increment it again; a retry at the configured attempt budget dead-letters the job.
The shared queue contract checks claim/retry accounting for local and AWS adapters.
Invalid lease duration or blank cell input rejects before querying. A competing
revision returns no lease; infrastructure failures propagate to the caller instead
of being reported as an empty queue.

These checks are mocked adapter qualification, not live deployment acceptance.
Expired-lease recovery, bounded
cell-specific candidate discovery, notification reconciliation and atomic fencing
of job-dependent content writes remain separate requirements. Existing historical
AWS attempt counts are not rewritten; jobs leased under older code may retain the
older attempt convention until explicitly reconciled. No backfill runs implicitly.

Complete, retry and dead-letter operations now reject missing, malformed or expired
leases before writing. Their DynamoDB transition also conditions on revision,
leased state, owner token and stored expiry later than the supplied current UTC
timestamp. State changes clear the expiry. The condition protects against changed
lease state between the read and write; it is not a database-generated clock or a
fence on external effects. Clock skew, requests delayed after timestamp capture,
lease recovery and job-dependent content transactions still require qualification.
