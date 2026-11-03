# Optional AI assistance

Ubeeq supplies an opt-in title polishing contract, server service, React controls,
and an injected Bedrock Converse adapter. Reference applications do not construct
the service or render its controls. No model, credentials, inference request, or
paid-service requirement is enabled by default. Moderation and security are separate.

`@ubeeq/extension-sdk` exports the `text.polish_title` feature registry, bounded
input/result validators, and `TitlePolishProvider`. Model output is data only.
`@ubeeq/api` exports `AiAssistanceService`; transports must derive `AiPrincipal`
from authentication, resolve stable title IDs, and implement current edit permission.
`AiAssistanceStore.commit` must atomically compare every supplied revision and
write every record or none. Use durable shared storage across workers and devices.
Never substitute process-local locks for the quota transaction.

Preferences default to false in the framework. Hosted products explicitly initialize
existing accounts with `initializePreference(principal, true)`, which never replaces
an existing choice. Off blocks direct calls. Generations invalidate results after
an off/on cycle; cancellation polls durable preference state while inference runs.
An already submitted provider request may incur a charge despite cancellation.
There is no background inference queue in this implementation.

The default lifetime allowance is **three attempts per stable title**, across
editors and text revisions, configurable with `perTitleLimit`. Each admitted
invocation, including a cache hit, refusal, timeout or dismissed suggestion, consumes
one attempt. Permission/validation/disabled/limit rejections consume none. Daily
user limits and conservative daily instance spend reservations are committed in
the same transaction. Unused reservations are retained after uncertain failures;
operator-provided maximum cost must bound the actual request cost. No automatic
provider retries occur. Cache entries are scoped to tenant/user, input, options,
context, model/geography and prompt version; source text is hashed in cache keys.

Wrap registered optional UI in `AiAssistanceProvider`. `AiAction` automatically
inherits visibility; `AiBadge` provides explicit labeling. `TitlePolishControl`
loads server availability, offers casing/language/preserved-name inputs, and shows
an escaped word comparison with Apply and Dismiss. Apply only calls the host's
draft updater. It never saves or publishes. Source revisions invalidate pending
results and captured stale Apply handlers. Hosts must refresh the server preference
on focus and across devices and remount the boundary when the account changes.
Use the same canonical tenant/user and shared preference store for linked products;
products with separate identities must keep choices separate until linking exists.

`BedrockTitlePolishProvider` accepts an injected Converse function, a configured
model/profile, and geography. Hosts use backend IAM and an abort-aware transport
with SDK retries disabled. No credentials belong in browser code. Geographic US
and EU cross-region profiles may route inside their respective supported regions;
an EU profile does not promise processing in a single region.

Telemetry callbacks receive outcomes, token counts and latency only. Acceptance
telemetry is an authenticated UI event, not proof of authorship or publication.
Hosts must not log request bodies, source text, descriptions, suggestions, provider
error bodies or credentials. Before enabling a provider, run the hosted quality
and latency evaluation with at least 100 real titles and verify current rates.
