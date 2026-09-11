# Work content references during content-v1 parsing

The parser now uses the shared core content-reference parser to require that
recognized body/media/comparison asset references belong to the same Work's
exported attachment set. Presence only in retained assets or another Work is
not sufficient. Both stored and portable field names use the existing shared
normalization rules. No source records are rewritten or detached automatically.

This validates recognized canonical asset relationships, not every product
extension, external URL, file ID or unsupported block type. The core parser's
structure budgets also apply. Product validation, authorized byte transfer and
durable restore execution remain required; passing this check is not restore
authorization. Consumers must adopt the shared revision explicitly.
