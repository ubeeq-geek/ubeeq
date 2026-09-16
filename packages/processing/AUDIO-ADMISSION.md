# Audio metadata admission

`validateAudioFfprobeOutput(probe, profile)` validates audio probe metadata with
product-supplied duration, channel, sample-rate and stream-count limits, exact
container/codec allowlists and an explicit profile identifier. There is no
product-specific default policy.

Exactly one audio stream is required. Stream indexes must be unique non-negative
integers; the returned index must be used for explicit native audio mapping.
Other streams reject unless the product permits video streams marked as attached
pictures. This permission does not authorize decoding or publishing that artwork.
Moving video and data/subtitle streams remain rejected.

Container duration is required. When supplied, a valid stream duration can only
increase the duration used for admission; it cannot shorten it. An absent or N/A
stream duration uses the container duration. Numeric strings are parsed strictly;
missing/nonfinite/nonpositive values do not become implicit defaults. Returned
metadata is whitelisted and omits arbitrary source tags.

Probe admission is not proof of complete decoding, MIME identity, harmless media,
or publication permission. Native processing still needs source-byte limits,
explicit local tools, time/resource limits, bounded outputs and source-version
binding. This change does not enqueue audio jobs or create previews: native audio
processing and product composition remain next steps. Existing video validation
behavior is unchanged.

Tests cover rejection boundaries and optional real FFprobe metadata from a tiny
generated PCM WAV. Set TEST_FFPROBE_PATH explicitly for that native test; no
binary is discovered or downloaded automatically.
