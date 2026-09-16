# Shared viewing sessions

## Product intent

A participant shares a room link through a messaging or social app. Viewers open the host application's room page and can keep using their existing group chat. No runtime AI, media rebroadcast, or built-in voice/chat service is required. Native galleries are the first client target; timed audio/video can use the same session state when the player supports programmatic control. This does not add hosted video delivery or promise playback inside a messaging app.

## Implemented in this PR

`SharedViewingService` in `@ubeeq/core` creates bounded sessions, reads authorized snapshots, and accepts host-only select/play/pause/seek/close actions. The returned server timestamp and playback anchor support late joins and reconnects. Selecting an item resets playback to paused at zero. Images only support selection; timed items require an explicit bounded duration. Position is clamped at media duration. Automatic playlist advancement is not included.

Rooms contain work references, never media URLs, access tokens, participant phone numbers or message contents. Sessions expire within 24 hours (two hours by default), contain at most 100 items and use atomic revision checks to prevent concurrent controls from silently overwriting each other. Clients must refresh after a conflict rather than blindly retrying an old control.

## Integration contract

- Bind `ViewingStore` and `ViewingAccess` to the same instance/cell. Room IDs must be server-generated opaque random identifiers; they are lookup keys, not credentials. Resolve trusted item kind and duration from the catalogue, not client claims.
- `canHost` checks current sharing eligibility, creator permissions and creation quotas. `canView` must check room admission plus content entitlement, visibility, age restrictions and holds for every playlist item before returning a snapshot. Future playlist metadata is therefore not leaked to unauthorized viewers. Recheck on every request, including host controls.
- Implement `create` with uniqueness enforcement and `compareAndSwap` with a real atomic revision condition. Do not emulate it with an unprotected read/write pair. Expired rooms are denied immediately even if storage cleanup has not run.
- The authenticated HTTP layer derives actor identity from the session, never request-body actor IDs. Apply bounded requests, CSRF protection where needed, per-actor/room quotas and safe error mapping. Missing, closed and unauthorized rooms all return the same service error.
- Add a room page with host controls and viewer follow mode. Start with bounded polling; return private/no-store responses. Responses contain a server clock sample; clients measure offset, ignore older revisions and correct position only when drift exceeds a tolerance. Autoplay failures must show a user-controlled play prompt.
- Fetch each item's media through existing authorized delivery endpoints. Independently enforce access on media requests; room access is not a replacement. Existing signed-link lifetimes govern how quickly already-issued media URLs can be revoked.
- Start with native image selection. Enable timed playback only for player adapters that support seek/play/pause and expose accurate duration. Unsupported external embeds should show an ordinary work link, not claim synchronization.
- Invitations must be revocable and scoped to one room; implement admission in the product host. Do not grant a purchase entitlement or relax host policy when redeeming an invitation. One home instance owns each room; cross-instance federation is a separate feature.

## Cost controls

Coordination carries small state snapshots. Media delivery is per viewer and counts against the existing delivery policy; no shared-stream cost reduction is assumed. Product hosts set polling intervals, room/participant limits, creation quotas and cleanup retention. Proactive messaging invitations/digests are separate, opt-in connector actions with their own costs. Closing a room stops access but does not delete the underlying work.

## Remaining before user rollout

This PR supplies the tested domain service and adapter contracts. Persistent store adapters, authenticated routes, invitation issuance, room UI, player adapters and ES/NF host wiring remain unimplemented. It does not deploy infrastructure, send messages or enable a live room. These are explicit product integration follow-ups; the service alone is not an end-to-end watch-party feature.

## Validation

Targeted tests cover gallery selection, late-join timing, pause/seek/duration clamping, viewer control denial, revoked read access, atomic concurrent controls, expiry/closure, bounded input and snapshot mutation isolation.
