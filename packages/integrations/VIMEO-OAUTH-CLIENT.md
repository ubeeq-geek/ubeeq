# Vimeo OAuth code exchange

The shared OAuth client performs a single bounded form POST and normalizes its
token response. Application credentials are sent in Basic authorization, never
in the URL. Missing/non-string access tokens are rejected. Invalid optional
expiry metadata is omitted rather than throwing during date conversion and
discarding an otherwise usable token. Missing expiry does not promise that a
token never expires; the caller must retain provider rejection handling.

The client does not select applications, store credentials, authorize callbacks,
consume state, or retry uncertain exchanges. Those responsibilities remain in
the composition and its durable OAuth replay store. The configurable API base
must be trusted. Tests use synthetic provider responses only.
