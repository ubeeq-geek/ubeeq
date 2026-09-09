# Import collection lineage

Reference sink calls receive the image's album followed by its known ancestors,
using scoped `getCollection` lookups against the migration's saved inventory.
Unrelated collections are not loaded. The workflow follows at most 100 nodes;
cycles, excessive depth and mismatched lookup identities fail the item before
sink or download effects. Existing item failure/retry handling applies.

A missing ancestor terminates traversal without inventing a record. Known
records retain their parent references so a partial inventory remains explicit.
This restores source context lost when whole-inventory reads were replaced with
bounded album lookups. It does not itself create empty groups, resolve missing
ancestors, or define product collection hierarchy and visibility policy.
