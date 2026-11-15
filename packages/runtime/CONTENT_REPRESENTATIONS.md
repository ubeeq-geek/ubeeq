# Retained content representations

`@ubeeq/runtime/content-representations` preserves immutable full and preview
manifests, uploaded previews, generated still images, text ranges and protected
full placements. The host supplies its actual scoped rich content records,
private byte storage, source verification, rendition/watermark implementation,
native destination recognition and current read policy. All bindings are
required; unsupported features must report their unavailable state explicitly.

Generated image previews use the retained Sharp algorithm and content identity.
They write private derivatives and preserve canonical originals. Uploaded
previews retain their exact bytes. Every media read rechecks the current source
and host policy before reading the stored private output. Full representations
cannot reuse protected native placements as a free reference. Host-specific
file metadata remains intact through the generic file descriptor type.

This service prepares and reads representations. It does not grant publication
authority, accept a release, synthesize a storage/provider adapter, or introduce
a second canonical writer. Hosts must keep actual processing admission, quota,
durable writes and recovery within their established authorities. The retained
host continues to own release authorization and recovery until its complete
shared composition is connected and verified.

The optional preparation-record repository currently owns its documented five
preparation kinds. A representation store must support the retained
`content-workflow:<tenant>:<creator>:representation` authority; it must not infer
an empty history or repurpose an unsupported record namespace.
