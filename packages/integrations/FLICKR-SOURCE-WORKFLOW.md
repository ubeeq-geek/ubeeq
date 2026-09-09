# Shared Flickr source workflow

`FlickrSourceWorkflow` processes confirmed source migration items using explicit
creator admission, quarantine transfer, scan and clean-source attachment ports.
It retains quarantine references for scanning resumes, classifies retryable
failures, and saves item results and transition audit events. The attachment port
returns whether an existing checksum was reused. It must throw
`FlickrSourceAdmissionError` for authorization/ownership failures that must abort
the workflow instead of becoming item failures.

This is a compatibility extraction, not a complete durable worker. The workflow
checks current connection ownership and creator access before transfer, after
scanning, and before the final checkpoint. These reads do not fence concurrent
revocation at the content write. Credential rotation is not checked. Processing
inspects at most 10 source items per resume by default (`run(migration, maxItems)`
accepts 1–100). Terminal/skipped entries count toward the budget. `sourceCursor`
persists the next position; an unfinished sweep returns RUNNING and a completed
sweep resets the cursor for retries or pending scans. Confirmation resets it too.
Saved catalogue arrays and audit comparisons still require whole-catalogue memory
and CPU; this is an attempt bound, not a request deadline or memory bound.
Content side effects and checkpoint writes remain separate. Applications need
idempotent attachments and durable storage. Checkpoint concurrency, automatic
scheduling and orphan quarantine recovery remain unfinished. A scan verdict is
supplied by the application; the shared workflow does not implement a scanner.
