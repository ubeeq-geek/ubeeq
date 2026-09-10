# Bounded sampled video frames

The file-based `extractValidatedFrames` helper also uses `extractLastFrame` when
the injected adapter provides it, preserving existing timestamp-labelled output
paths and metadata. Legacy tools without that method retain timestamp seeking.
Final-frame decoding failures propagate; there is no successful-plan fallback.
The file-based helper does not gain the byte budgets of `FfmpegFrameProcessor`:
its caller still owns source and generated-file limits and attempt cleanup.

`FfmpegFrameProcessor` adapts deterministic video sampling to `MediaProcessor`.
Install it explicitly where sampled JPEGs are needed; existing poster and audio
processors and default registries are unchanged. Products supply admission policy,
including an explicit `maxFrames`, and positive safe-integer `maxSourceBytes`,
`maxFrameBytes`, and `maxTotalBytes` budgets.

The source bytes, version, policy and limits are snapshotted. Admission precedes
extraction. Frames include the final millisecond from the shared sampling plan;
IDs are `frame:<sourceVersionId>:<timestampMs>`, in ascending timestamp order.
The final planned timestamp labels the actual last decoded frame, not a seek past
its presentation timestamp. `VideoFrameSamplingTools.extractLastFrame` decodes
through EOF, replacing a single output JPEG. This adds one full decode pass,
bounded by the native command timeout; it does not buffer the full clip's frames.
Each preview carries its immutable source version. Measured units count frames.
No partial result is returned when any extraction fails. Attempt files are removed
on success or failure; only one extracted frame is retained on disk at a time.

This is not a safety verdict, video transcoding, publishing, or a durable job
implementation. Callers own authorization, private persistence, source-version
and lease fencing, and any moderation decision. Do not expose these outputs merely
because their role is `preview`. Nothing automatically installs this processor.

Byte bounds are checked before reading generated files and cumulatively before
retaining them. They are not OS disk quotas: an injected decoder can write more
before it returns. The supplied native adapter limits each command's time and
output width; the caller still owns the overall attempt deadline and execution
sandbox. The source is held in memory, so set budgets for the worker's memory
envelope. JPEG signature checks are not full independent decoder verification.
