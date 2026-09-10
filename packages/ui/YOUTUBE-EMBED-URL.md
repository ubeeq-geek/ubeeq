# YouTube embed URL mechanism

`resolveYouTubeEmbedUrl` parses stored watch, short-link, shorts and embed URLs
and constructs an HTTPS youtube-nocookie embed URL. It preserves the existing
6–20 character identifier acceptance contract; that is not proof a video exists.
Source queries cannot set playback controls or the embedding origin. Callers
explicitly supply autoplay, muted and optional web origin. Defaults do not request
autoplay and do request mute. There is no ambient window access.

Only recognized HTTP/HTTPS hosts without credentials or non-default source ports
are accepted. Invalid inputs return null. No network request, iframe, consent,
authorization or privacy guarantee is provided by this helper. Products still
own whether an embed is allowed and when a provider may be contacted.
