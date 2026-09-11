# Private media React player

`PrivateMediaPlayer` is exported from `@ubeeq/ui/react`. Supply `kind` (audio or
video), a stable `load(): Promise<Blob>` callback, optional caption and button
class, and explicit `copy` strings for initial/loading/loaded/loadError/
playbackError/button/label. Products own wording and media admission.

No request occurs until the button is clicked. The shared playback helper
deduplicates downloads and owns the object URL. Unmounting, changing the loader,
or changing media kind disposes that session, revokes its URL and clears the
media element. Late responses do not revive disposed sessions. Controls are
enabled, preload is disabled and playback is never started programmatically.
Loading failures permit retry.

This does not authorize an Asset, constrain response bytes, transcode media or
publish anything. Bind the loader to an admitted identity and replace it (or
remount the player) when that identity changes. Browser codec support and actual
browser interaction still require product validation.
