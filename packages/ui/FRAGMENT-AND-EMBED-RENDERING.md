# Fragment and embed fallback rendering

The shared BlockPreview renders `html_fragment` as escaped source inside a
scrollable `pre`. It does not sanitize the source into executable markup or
activate scripts, images, links or styles contained in it. The stored body is
unchanged.

An `embed` renders its title, label and caption with an explicitly non-playing
source link. Links use the existing HTTP/HTTPS/mailto allowlist and noopener /
noreferrer isolation. Other schemes remain inert text. Provider payloads are
not interpreted and no iframe is created. This is the generic fallback, not
provider-specific playback support; admission, consent and provider composition
remain product responsibilities.
