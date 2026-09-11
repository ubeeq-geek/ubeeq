# Shared cover preset picker

ProfileCoverPicker in the React entry point accepts caller-owned option IDs,
labels and image URLs, selected preset, preview, title and explanatory copy.
It owns only open/close and selection presentation. Existing CSS hooks remain.
An empty catalogue renders nothing; disabled state blocks both the toggle and
already-open choices. The caller owns persistence and custom-cover policy.

Tests cover SSR and injected React state for selection/close and disabled options.
Keyboard navigation and visual/screen-reader browser qualification remain pending;
this extraction does not claim a fully qualified listbox implementation.
