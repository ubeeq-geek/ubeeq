# Vimeo read client

`VimeoReadClient` provides account, single-page video catalogue and individual
video metadata reads through the bounded request helper. Account and catalogue
results use the shared metadata projections. Individual video reads preserve the
provider object for callers that need transcode and embed fields; callers must
not serialize the entire object to clients without their own projection.

The client validates page numbers and video resource paths before fetching.
Page size retains the 1–100 clamp for integer inputs. It never follows catalogue
continuations automatically. Callers own whole-scan budgets, durable checkpoints,
credentials, authorization and product policy. The configurable API base is a
trusted composition setting, not a user-supplied destination.

Tests use fake HTTP responses through the real bounded request implementation.
They do not qualify live Vimeo, write operations or upload recovery.
