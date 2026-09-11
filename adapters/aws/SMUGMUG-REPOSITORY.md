# SmugMug DynamoDB repository

`DynamoSmugMugRepository` implements the shared integrations repository contract.
Applications supply a DynamoDB document client and table name. No application
permissions, deployment configuration or credential encryption are included.

The extracted adapter preserves existing uppercase `PK`/`SK` records and
`SMUGMUG_*` entity names. It does not use the general adapter's lowercase-key
table schema or automatically add cell/tenant prefixes. Use a separately
configured compatible table and retain application authorization checks.

Inventory metadata writes use chunks of at most 24 upserts plus a connection
condition check. Inventory completion writes the guarded connection, migration
receipt and discovery index in one transaction. Conditional conflicts are
distinguished from infrastructure failures. Page methods use bounded strongly
consistent queries and validate continuation partitions.

This preserves behavior, not production qualification. Legacy full-list methods
remain unbounded; large individual records can exceed DynamoDB item/transaction
limits. Unconditional legacy writes and external content/provider effects are
not fenced by these transactions. There is no index backfill, deployment, live
database validation or schema conversion in this extraction. Tests use injected
clients to verify command construction and error handling, not a live database.
