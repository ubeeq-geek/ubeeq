# Creator list evaluation budgets

Work and collection list options accept an optional positive `maxRecords`.
Implementations must return the complete result or throw
`CreatorContentListBudgetError`; they must never return a partial inventory as
success. The budget may include deleted/filtered records and empty continuation
pages. A one-record lookahead may be used to prove overflow.

The in-memory implementation checks each creator-owned record before retaining
it, including deleted records. Existing unbudgeted callers retain their behavior.
This bounds additional result materialization, not the original in-memory store,
and does not establish a snapshot, authorization or a transactional reservation.
