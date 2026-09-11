# Work discovery participation metadata

createWorkDiscoveryParticipation constructs none/eligible/opted_in/removed records
with caller scope and time. Each call replaces the participation snapshot: only
the active state's timestamp and removal reason are set. This preserves the
existing metadata convention, not an append-only history or eligibility engine.

Products own authorization, public/live admission, removal-reason sanitization,
persistence, ranking and discovery feeds. Calling the constructor does not grant
permission, publish content or complete a discovery workflow. Tests cover all
states and invalid input; product routes must exercise actual consumption.
