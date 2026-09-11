# Content-v1 import ordering validation

The shared parser rejects duplicate explicit attachment positions within one
Work and duplicate membership positions within one collection. Different parents
may reuse positions; sparse positions are preserved without sorting or rewriting.
This prevents ambiguous source ordering from passing import preflight.

Legacy asset records without explicit attachment metadata remain supported by
the existing format; this change does not invent positions or authorize restore.
Product field validation, byte transfer, execution authorization and durable
transactional import still need implementation. Existing malformed exports must
be reconciled at their source, not silently reordered during import.

The content-v1 planner calls this parser, so its callers inherit the validation
when adopting this shared revision. Product pins must be advanced deliberately.
This is a restore prerequisite, not a completed restore workflow.
