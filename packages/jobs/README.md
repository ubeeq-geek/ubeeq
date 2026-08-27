# Jobs ports

`@ubeeq/jobs` defines durable queue and scheduler contracts for upload, processing, synchronization, publication, moderation, and notification work.

Adapters must implement idempotent enqueueing, leasing, bounded retries, cancellation, dead-letter disposition, and manual recovery. An in-process worker may be used only by a local adapter; it is not the durable production reference.
