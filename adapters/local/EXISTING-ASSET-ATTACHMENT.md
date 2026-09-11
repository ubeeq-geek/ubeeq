# Existing private asset attachment

`CreatorExistingAssetService.attach(tenantId, workId, sourceWorkId, assetId,
checksum)` authorizes both Works and delegates to the local store's atomic
`commitExistingAssetAttachment` operation. Source and target must be active
(neither archived nor deleted) and owned by the same creator in the same tenant.

The commit rechecks source membership, private stored-object metadata, checksum,
non-deleted asset state and completed processing for the current source version.
It conditions the target update on its expected revision, preserves creator
metadata and any existing primary asset, and appends only the new membership.
Repeating an existing membership does not increment the revision. No asset is
replaced, storage object copied, or processing job scheduled.

The operation joins an owned local import transaction, allowing a consumer's
source receipt and membership to commit or roll back together. An asset must
still have valid source custody at commit time; a stale lookup is insufficient.

This is an explicit attachment primitive, not checksum discovery, moderation
approval or an automatic import policy. Consumers must retain source receipts to
avoid automatically reattaching an asset a creator previously removed. They must
also recheck connector admission and source identity. Production/distributed
adapter implementations and checksum discovery are separate work.
