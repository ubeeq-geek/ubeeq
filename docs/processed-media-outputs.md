# Processed media outputs

The core worker persists the bytes returned by an installed `MediaProcessor`.
The uploaded original and its logical source version remain unchanged.
`mimeType` describes the source; `deliveryMimeType` describes the canonical
stored delivery object. `processedRenditions` retains each output's identity,
source version, role and immutable storage reference.

A single encoded `preview` becomes the canonical delivery object. A processor
returning several previews can set `primaryRenditionId` explicitly. Without that
choice, the existing full-source derivative remains canonical. Posters never
replace playback. Auxiliary renditions remain private. The configured image
transform port also applies to encoded image outputs.

Before writing an output, the worker validates every output's identity, source
version, MIME type, declared length and bytes, then persists a bounded output-set
journal. Encoded outputs require a durable host-record repository and recoverable
physical output writes. Default local adapters support these mechanisms without
introducing a paid quota. Legacy source-only processors retain their existing
behavior.

Identical outputs with the same MIME type and access scope share one physical
write within the processing generation; all aliases remain recorded. The
physical-write journal reserves storage and settles accepted bytes independently
of the final asset transaction. The asset still consumes one processing unit.
A complete recovered output set needs no second encoder call. An incomplete set
may rerun the encoder, but changed recipes or bytes require reconciliation rather
than replacing an accepted version. Missing new journals cannot be treated as
legacy single-output receipts. Actual legacy receipts remain recoverable.

The worker checks current asset and lease evidence before writing and attaching
outputs. Hosts can select a bounded `processingLeaseSeconds` from 30 to 900
seconds for installed native processors; the existing default remains 60.
Their worker execution budget must accommodate that processing work.
Failed attachment does not erase accounting for retained files. Output
bodies never enter asset, job or journal JSON. Portable inventories include actual
output hashes, originals and aliases; ordinary metadata imports discard storage
capabilities. Explicit regional migration transfers each distinct physical file,
verifies its destination receipt and rewrites every alias to that receipt.

Synthetic worker tests verify persistence and failure recovery. Codec validity
remains the installed processor's responsibility; the media adapters have
separate native decoding tests. A successful local worker test does not certify
a deployment's executable layer, IAM permissions or provider configuration.
