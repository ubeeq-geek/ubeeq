# Connector error compatibility

`ExternalProviderError` provides a shared failure vocabulary and preserves optional delay and account-operation metadata. Provider adapters still decide how status codes, provider payloads and ambiguous transport outcomes map to it. Error messages may contain provider details: callers must redact before logging or exposing them publicly.

`parseRetryAfterSeconds` preserves existing connector behavior: nonnegative numeric inputs round upward; other inputs use JavaScript date parsing, with expired dates clamped to zero. This compatibility parser intentionally retains permissive numeric syntax and whitespace handling; it is not a strict HTTP header validator. No scheduler, delay cap, jitter or remote retry is added. Callers must validate timing inputs, bound delays, persist recovery state and reconcile ambiguous submissions before replaying writes.
