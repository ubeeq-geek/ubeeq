# Stable inputs for video processing

FfmpegPosterProcessor copies the validation profile at construction and snapshots
source bytes, content type and sourceVersionId before its first await. Poster
metadata and rendition IDs use those captured values. Temporary source files use
mode 0600. The standalone renderVideoPoster helper also snapshots bytes, capture
time, output budget and tool reference before creating its attempt directory.

FfmpegVideoToolAdapter copies its constructor options, preventing later caller
edits from changing binary paths or frame width. Injected tool implementations
remain trusted dependencies; arbitrary mutation inside a custom implementation
is not isolated by these snapshots.

These changes close caller-mutation races, not distributed worker races. Durable
workers must still verify source checksum/version, enforce source-byte admission,
lease fencing and atomic persistence. Buffer copies have memory cost; this adds
no hard memory quota or total deadline. Valid inputs retain existing poster
recipes, source identity and output shape. Product runtime defaults are unchanged.

Tests mutate bytes, lineage, policy, capture controls, output budget and tool
configuration while retaining the original operation. Existing failure cleanup
and native audio/video tests also pass. Product pin adoption remains separate;
no live processing or deployment was run.
