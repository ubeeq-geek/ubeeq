# Canonical object-key containment

`isObjectKeyWithinPrefix(key, prefix)` compares a canonical application-generated
key against a path-segment prefix. It rejects empty/dot segments, absolute paths,
backslashes, control characters and percent escapes. It does not URL-decode keys.
This intentionally excludes arbitrary URL-encoded object names from this API.

The prefix must come from authenticated identity and an ownership check, not from
the submitted key. Containment alone does not authorize a read, validate a bucket,
bind an immutable object version, verify bytes or make a filesystem symlink safe.
Use it with application-issued keys and a controlled storage namespace.
