# Flickr source download

downloadFlickrSource extracts the provider-host check, redirect rejection,
30-second abort signal, declared/stream byte limits, stream cancellation, image
signature detection and SHA-256 calculation. It returns bytes and metadata; it
does not persist objects or mutate the provider.

Callers authorize the creator, select a byte budget, persist private quarantine
objects and run their scanner before promotion. Signature detection is not full
image decoding or a safety verdict. Existing source-host matching is preserved;
this extraction does not claim stronger URL, MIME or provider-account validation.
