# Public derivative object storage

`createS3PublicDerivativeStore` supplies low-level S3 copy and remove operations
for product-admitted public derivatives. It replaces source metadata with the
declared content hash, content type and a five-minute cache policy. Source key
segments are URL encoded. Destination encryption settings come from the bucket;
the adapter does not request an ACL or override its KMS configuration.

The caller owns authorization, cell/bucket restrictions, derivative validation,
unique publication keys, publication transactions, withdrawal and reconciliation.
The supplied hash is metadata, not a checksum computed or verified by this
adapter. Source copying currently identifies a key, not an immutable S3 version;
the caller must provide immutable derivative keys. A poster does not authorize
copying its original. Removing an object is not instant cache revocation.

There is no application-level retry or automatic cleanup here. Errors propagate
unchanged, including ambiguous responses; configured SDK retry behavior remains
the client's responsibility. Tests inspect mocked commands, not a live bucket.
