# AWS serverless multi-cell

This optional deployment owns the routing-directory and migration-checkpoint control plane for independent AWS serverless cells. It stores only route and migration metadata; creator records, source media, credentials, moderation evidence, queues, and backups remain in each cell.

Deploy this only after at least one [`../single-cell`](../single-cell) deployment exists. Configure each cell with the emitted directory table name, ARN, and region. The cell receives read-only routing access; an explicitly authorized migration worker receives directory write access and a deployment-specific `MigrationExecutor`.
