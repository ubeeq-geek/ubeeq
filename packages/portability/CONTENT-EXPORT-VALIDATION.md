# Content export preflight

`parseCreatorContentExport(json, limits?)` parses the content-v1 envelope, distinct
from repository export v2. It supports Creator identities expressed as `creatorId`
or `id`, requires consistent source ownership, and preserves product fields and
storage-reference shapes. It validates Work/asset/collection identities, primary
and cover references, attachment and collection membership, and publication Work
scope. Shared assets may appear in multiple Works only with identical asset data.
Retained assets cannot duplicate attached assets. Sparse membership positions are
preserved because policy-filtered exports can legitimately leave ordering gaps.

Defaults cap JSON at 10 MiB, 100,000 traversed nodes and depth 64. Unsafe prototype
keys, non-finite numbers, invalid envelopes and known credential fields inside
integration accounts reject. This is not arbitrary-secret detection in user text.

The returned manifest is parsed data, not trusted restore input. No storage URL is
fetched and no references grant access. This gate does not authenticate the source,
verify object checksums/bytes, validate every product field or content block,
authorize a target Creator, resolve target conflicts, strip live execution state,
or commit a restore. Product policy and a transactional restore planner remain
required. Incomplete policy-filtered exports with dangling references reject;
they must not silently become apparently complete restored libraries.
