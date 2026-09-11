# Shared profile avatar renderer

The React ProfileAvatar renders either the supplied image or the existing
three-color fallback mark. Callers select the fallbackPalette tuple and provide
their own identity mapping, palettes, CSS, image URLs and alt text. The renderer
does not select a product palette or fetch, authorize, or publish media.

Named fallbacks use image semantics; decorative fallbacks are hidden from
assistive technology. Existing fallback classes and CSS custom properties are
preserved. SSR tests cover image output, escaped labels, caller colors and
decorative semantics. Visual and screen-reader browser QA remain outstanding.
