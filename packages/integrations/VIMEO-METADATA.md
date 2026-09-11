# Vimeo metadata projections

The account, video, and video-page normalizers accept provider JSON and expose a
metadata-only projection. Upload links, originals, downloads, and credentials are
not copied. Video collections require an explicit array and every item must have
a resource identity; malformed pages cannot silently become a successful empty
or partial result. Optional numeric fields retain finite numbers, including zero.

These are pure mappings, not a complete connector. The caller owns bounded HTTP
reads, authentication, retry classification, pagination budgets and checkpoints,
publication policy, and durable storage. The page helper retains sequential page
number continuation behavior; it does not fetch or validate the remote next URL.
Tests use synthetic metadata fixtures and do not qualify a live provider account.
