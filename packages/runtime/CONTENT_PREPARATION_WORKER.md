# Retained content in the shared worker

A core host that installs retained preparation HTTP must also return its actual
`runNextJob` binding. The factory receives the same adapters, host ports and
instance/cell scope for both paths. A missing worker rejects construction rather
than accepting preparations that this host cannot recover.

`ContentWorkflowService.recoverNext()` resumes one accepted assembly command
under its saved actor's current authority. `ContentReleaseService.runNextJob()`
handles one due release or pending cancellation using its existing conditional
claims, review fingerprints, policy checks and child receipts. Future releases
remain pending. Invalid persisted schedules become `needs_review` and cannot
publish. The original full records and immutable representations remain canonical.

`createContentPreparationWorker(workflows, releases)` combines the two services
and rejects a different workflow instance. The worker ID is not an actor and is
never used to grant creator access. The core host alternates retained and existing
queues, tries the other queue after a failure, records retained deferrals, and
propagates failure when neither queue makes progress. Commercial hosts drain this
through their existing combined worker; server-owned deployment dependencies can
supply the retained host in both local and managed compositions.

The poll selects one retained command, but discovery still enumerates the host's
creator and command inventories. One assembly or release can contain multiple
conditional child operations. Fairness cursors are process-local scheduling hints;
canonical receipts remain the authority across restarts. Deployment work still
needs paged discovery and recovery/load acceptance for the full managed cohort.

This connects a previously missing execution path. The default full rich host,
all provider bindings and complete shared browser/admin workflows remain required
before the requested manual review and later release gates.
