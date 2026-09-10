# Opt-in durable audio processing

Construct LocalCreatorLibraryStore with `enqueueAudioProcessing: true` only when
the consuming runtime has installed an audio MediaProcessor. The default remains
disabled; image/video options keep their existing behavior.

Pending audio attachments enqueue creator-asset.process inside the existing
attachment transaction, binding tenant, creator, Work, asset and source version.
Failure in the surrounding receipt transaction rolls back the job and attachment
together. Existing-asset reuse does not create another processing job.

Audio regeneration uses the same authorization, admission, revision/source
checks, deduplication and active-job exclusion as other supported media. Image
crops remain invalid for audio. Previous completed renditions and originals stay
in place while a replacement job is pending. The existing worker commit fences
apply; this option does not bypass them or install a decoder.

SQLite tests cover enabled/disabled behavior, transactional rollback, restart,
MP3 rendition persistence, authorization, crop rejection, duplicate requests and
preservation of prior outputs. Product runtime policy, player wiring, native
end-to-end processing and publication remain separate acceptance work.
