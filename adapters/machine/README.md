# Machine adapters

`@ubeeq/adapter-machine` supplies the provider-neutral durable primitives for
scalable, non-hyperscaler Ubeeq cells:

- PostgreSQL revisioned repositories with optimistic concurrency, paging,
  idempotency retention, and atomic transactions; and
- PostgreSQL `SKIP LOCKED` worker leases, retries, recovery, and dead-letter
  state.

Set `UBEEQ_POSTGRES_TEST_URL` to a disposable PostgreSQL database to run the
same persistence and job contract suite used by the other adapters. Object
storage, identity, and credential-vault implementations are deliberately
separate adapters; a scalable composition must provide every required port.
