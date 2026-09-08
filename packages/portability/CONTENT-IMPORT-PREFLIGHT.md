# Content import ID preflight

`planCreatorContentImport(json, inventory)` parses and validates the shared
content-v1 graph, preserves incoming identities and reports Work, asset and
collection ID collisions. Reused assets are counted once; detached retained
assets are included. The caller must supply complete collision information for
the target identifier namespace, including records owned by other Creators.

The result identifies every asset requiring access/integrity verification, but
does not return source storage URLs as executable instructions. It never fetches
objects or writes data. Even a conflict-free result has `executionAuthorized:
false`: target authorization, product validation/policy, slug and related-record
conflicts, verified byte handling, live-state exclusion and an atomic commit are
separate mandatory gates. Inventory can change after planning; commit must recheck.

Explicit target identity and bounded ID inventories are required. Existing ID
arrays are capped at 100,000 each; source parsing uses the content parser budgets.
This is a diagnostic plan, not a successful restore or a completeness guarantee
for a caller-supplied partial inventory.
