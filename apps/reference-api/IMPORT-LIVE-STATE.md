# Metadata-only import state

The reference API's explicit metadata import keeps assets pending and strips
source `storage`, `originalStorage`, `processing` and top-level `renditions`.
The source checksum and object version remain available as metadata for later
verification, not as proof that bytes exist at the target.

Publications become drafts and no longer retain the source `remoteId`. The
destination and content relationships remain metadata; the import does not
enqueue processing or publication jobs. Its response reports
`originalFilesTransferred: false` on the initial commit. Existing checkpoint
idempotency and atomic record/checkpoint/audit commit behavior remain intact.

The HTTP regression test uses disposable SQLite storage and confirms stripped
fields, retained content metadata, an unchanged job table and idempotent replay.
This does not qualify full restore or every possible extension field. No
existing completed import is rewritten on replay. Earlier imported records may
need a separately reviewed recovery operation. The regional byte-transfer path
and product content-v1 preflights are unchanged.

Creator-level moderation evidence, holds, review cases and audit subjects are
remapped from the source creator ID to the authenticated target creator ID.
Work and asset subject IDs remain unchanged because their imported identities
are preserved. Hold state, reasons and evidence payloads are retained; importing
content is not a moderation waiver. An active creator hold can therefore affect
the target creator's other content too. Existing completed imports are not
retroactively repaired.

The HTTP test verifies the remapped records and confirms that the imported
creator hold blocks publication of a Work without a direct hold. Its disposable
asset fixture is marked ready solely to reach the moderation gate after the
earlier metadata-only import assertions; this is not byte-restore validation.
