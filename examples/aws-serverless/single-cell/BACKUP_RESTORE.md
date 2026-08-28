# AWS serverless single-cell backup and restore

This is an operator runbook for the optional AWS composition. It covers instance data only; never put credentials or connector secrets in creator exports.

## Back up

1. Enable DynamoDB point-in-time recovery and S3 versioning before accepting production writes. The CDK example enables both.
2. Schedule DynamoDB on-demand backups or an AWS Backup plan for the records table. Record the table ARN, backup ARN, region, and recovery point.
3. Replicate or back up the source and delivery buckets according to your retention requirements. Include object versions and delete markers in the inventory.
4. Preserve the deployed API artifact revision, its configuration, the CloudFormation template, and the relevant secret *references* (never secret values) with the backup record.
5. Regularly run an authenticated creator export and retain its checksum as an application-level portability check.

## Restore and verify

1. Restore into a new, isolated table and bucket pair; do not overwrite a running production instance during a test restore.
2. Deploy the same Ubeeq API artifact revision with configuration pointing only to those restored resources.
3. Run the adapter live-conformance gate with a disposable Cognito user, then verify `/health` and `/ready` through the authenticated deployment path.
4. Import a representative creator manifest in dry-run mode and compare creator, Work, Asset, Collection, publication, audit, and job counts with the backup inventory.
5. Read several immutable object versions and compare their recorded SHA-256 checksums. Test a direct-upload completion and a delivery grant.
6. Record the evidence and only then make the restored endpoint eligible for a traffic cutover.

## Incident recovery

For accidental object deletion, first recover the specific S3 version rather than copying a newer object over the same key. For data corruption, restore a point-in-time copy into isolated resources, verify it, then perform an explicit controlled cutover. Creator exports can reconstruct portable metadata but intentionally exclude sessions, passwords, OAuth tokens, and encrypted credential payloads.

See [MIGRATION.md](MIGRATION.md) for a planned local SQLite/filesystem-to-AWS move.
