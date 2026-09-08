# Bounded Vimeo requests

`requestVimeo` performs one injected fetch, rejects redirects, combines caller
cancellation with a 30-second default deadline, and limits response bodies to
4 MiB before returning a detached response. Explicit limits may be selected up
to five minutes and 16 MiB. The fetch implementation must honor its abort signal;
this is not an independent watchdog for nonconforming injected streams.

The shared `VimeoApiError` preserves status, retryability and numeric Retry-After
behavior. Even an unreadable error body retains its known HTTP failure status.
Transport failures and successful-but-unreadable bodies propagate without retry.
Those failures do not prove an external write failed: the caller must reconcile
uncertain upload/creation outcomes rather than blindly replaying them.

URL admission, upload-host validation, credential selection, source-byte limits,
recovery checkpoints and product policy remain caller responsibilities. The
helper does not qualify a complete secure connector or perform live operations.
