# MCP control-plane foundations

Ubeeq treats MCP as an external management surface, not as an embedded chat product. Human UI and MCP clients should operate on the same product-neutral policy model and validation rules.

## Principles

- External assistants configure and invoke deterministic Ubeeq tooling; routine synchronization does not require an LLM.
- MCP adapters expose intent-level operations rather than raw persistence primitives.
- Every mutation is subject-scoped, idempotent, and optimistic-concurrency guarded.
- Capability discovery is explicit so clients can determine what each connected platform can actually support.
- Preview/dry-run should be available before applying material policy changes.
- Ubeeq remains responsible for authorization, validation, auditability, provenance, and execution.

## Work flow model

Each syncable Work field can have zero or one upstream source and zero or more downstream destinations.

Example:

```text
YouTube title -> Ubeeq title -> Vimeo title

Ubeeq tags -> YouTube tags
           -> Vimeo tags
```

A platform-specific value may remain independent by omitting it from the downstream set. Different fields on the same Work may have different upstreams and downstreams.

`ubeeq` is a valid upstream endpoint when the shared Work value is authored in Ubeeq. Ubeeq is not a downstream endpoint because downstreams represent external publications/connections receiving compatible changes.

## Initial control permissions

The foundation defines separate permissions for:

- integration discovery
- Work/flow reads
- flow-policy writes
- publication writes
- revision reads
- revision rollback

MCP transport authentication should map the authenticated client to a Ubeeq subject and these permissions. The transport must not bypass the normal application authorization boundary.

## Initial intent-level tools

The contract reserves operations for:

- listing integrations and capabilities
- reading a Work flow policy
- previewing flow-policy mutations
- applying flow-policy mutations
- publishing through a connected platform
- listing and rolling back revisions

The initial branch implements the policy contracts, authorization vocabulary, deterministic preview, and application-facing control-plane port. A protocol-specific MCP server can adapt MCP requests to this port in a later change without coupling core integration contracts to an MCP SDK.

## Safety and synchronization

Remote platform deletion must not implicitly delete a Ubeeq Work. Remote observations and imported updates should remain revisioned so a creator can recover from unwanted edits, account compromise, moderation changes, or loss of remote account control.

Platform capability checks should be performed before a flow policy is applied. Unsupported upstream/downstream routes should be rejected or presented as unavailable rather than silently ignored.
