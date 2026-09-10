# Shared cover preset picker

ProfileCoverPicker in the React entry point accepts caller-owned option IDs,
labels and image URLs, selected preset, preview, title and explanatory copy.
It owns only open/close and selection presentation. Existing CSS hooks remain.
An empty catalogue renders nothing; disabled state blocks both the toggle and
already-open choices. The caller owns persistence and custom-cover policy.

Tests cover SSR and injected React state for selection/close and disabled options.
Opening focuses the selected option (or first option). Arrow Up/Down and Home/End
move focus without saving a selection. Native button activation selects; Escape
closes without selecting. Selection and Escape return focus to the toggle.
Only the active option is in the tab order during keyboard navigation.
These interactions follow the WAI-ARIA listbox keyboard guidance:
https://www.w3.org/WAI/ARIA/apg/patterns/listbox/
Type-ahead and visual/screen-reader browser qualification remain pending; this
does not claim a fully qualified listbox implementation.
