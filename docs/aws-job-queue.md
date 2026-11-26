# AWS durable queue compatibility

`AwsJobQueue` uses DynamoDB as its source of truth and SQS as a wake-up signal.
Workers and filtered operator lists visit repository pages until they find the
requested eligible records or exhaust the repository. Completed history, foreign
cells and unrelated job types on an earlier page must not hide later work.
Lease deadlines use the clock after page reads; claims still compare the stored
revision, cell, state and due time atomically.

The persisted `correlationId` remains the existing worker/token ownership marker.
Changing that fence independently would let an older worker acknowledge a newer
lease during a rolling upgrade. The additive `requestCorrelationId` field retains
the original request trace while public queue results expose only that trace and
return the lease token separately in `JobLease.leaseToken`.

An unclaimed legacy record can retain its original trace on its first new claim.
An already-attempted legacy record may have lost that trace; public results omit
it rather than presenting its worker ownership token as a request ID. Existing
lease acknowledgements continue to use the unchanged ownership and revision
conditions. No job ID, state, attempt budget or index migration is required.

These changes fix correctness with existing repository indexes. They do not
introduce a scheduling index or claim constant-cost scans as history grows.
Deployments should retain their periodic durable recovery worker when SQS
notifications are lost.

For an explicit local DynamoDB endpoint, the opt-in engine regression checks both
upload recovery and queue pagination against unique, automatically removed tables:

```sh
TEST_DYNAMODB_ENDPOINT=http://127.0.0.1:8000 \
  node --test adapters/aws/test/upload-lifecycle.dynamodb.mjs
```

The harness requires a loopback endpoint and uses dummy credentials. It is not an
AWS deployment or provider acceptance test.
