# Direct messaging integration: initial shared implementation

Creators can check activity using explicit commands without running an assistant or paying for inference. AI is a development/configuration aid, not a runtime dependency. Future creator-owned assistants can call the same authorized application operations.

## Included

`@ubeeq/integrations` exports a channel-independent command handler for `activity`, `comments`, `favorites`/`favourites`, and `help` (optional slash prefix). It returns up to five recent comments and an explicitly aggregate favourite count with snapshot freshness. Unsupported requests return help; unavailable counts are not represented as zero. This is a recent snapshot, not an unread feed or a performance delta.

The WhatsApp adapter verifies the raw-body HMAC before JSON parsing, handles verification challenges, scopes inbound events to the configured receiving phone-number ID, extracts text and interactive command IDs, and builds bounded text reply payloads. Status/non-command media events are ignored. Batch duplicates are removed; durable retry deduplication remains a host requirement.

## Host composition required before activation

This PR is a shared integration foundation, not a deployed end-to-end WhatsApp service. No HTTP route, account-linking UI, persistent inbox/outbox, provider credentials or live send is installed.

1. Configure the receiving WhatsApp business account, phone-number ID, app secret, verification token and supported Graph API version in the host's secret/configuration system. Keep each host's identity and credentials isolated.
2. Add an HTTP receiver with a streaming 256 KiB body cap. Use original bytes with `decodeWhatsAppWebhook`; never reserialize JSON before checking the signature. Invalid signatures must not reach application logic. Map verification challenge results to an appropriate HTTP response.
3. Durably admit each verified message to an inbox keyed by instance, receiving account and provider message ID before acknowledging it. Duplicate deliveries must reuse the same record. Apply sender/account quotas before processing; retain deduplication records across provider retries.
4. Link a sender through an authenticated dashboard workflow using a short-lived, one-use possession challenge. Never grant access by matching a public phone number. Bind each link to instance/cell/user/creator and receiving account. Provide revocation and creator selection in the dashboard.
5. Implement `DirectMessagingPorts`. Recheck current membership/read permission on every query. Bind the activity reader to the returned tenant/cell/creator, exclude hidden/deleted/restricted records, bound storage work, and preserve source synchronization timestamps. Never perform unbounded connector refreshes on message receipt. A successful link is not permanent authorization.
6. Persist replies in an outbox before delivery. Use the configured provider endpoint and credentials with deadlines and bounded responses. Handle transient failures and uncertain delivery explicitly; do not claim exactly-once provider sending. Do not expose exceptions, tokens or comment bodies in logs.
7. Recheck the provider's current messaging-window, template, opt-in and pricing requirements before enabling delivery. This phase supports on-demand replies only; proactive digests require separate delivery policy and budget controls. Review stale queued messages before sending.

ES/NF can implement these ports against their existing activity readers; self-hosted installations can provide their own adapters. Brand-specific infrastructure and policy belong in the consuming repositories. No live credentials or production deployment are required to test this package.

## Follow-up scope

Authenticated hosted routes and linking UI; persisted inbox/outbox and rate limits; paginated conversations; unread checkpoints; scheduled digests; explicit confirmation for writes; delegated API/MCP access. No automated reply generation or runtime LLM service is included.

## Verified sender linking contract

An authenticated dashboard issues a short-lived challenge for an authorized creator
and the configured receiving account. It displays `/link <challengeId> <token>`;
the user sends that command from their WhatsApp account to the configured business
number. Do not accept a dashboard-supplied sender ID as proof of possession.

After `decodeWhatsAppWebhook` verifies the original request signature and receiving
account, pass each decoded message to `handleVerifiedDirectMessagingLinkCommand`.
The helper checks the token, expiry, instance/account scope and current creator
authorization. The sender is taken from the verified event. The host implements
`VerifiedDirectMessagingLinkStore`: `commitVerifiedLink` must compare the current
unused challenge and save its consumption and the verified link in one atomic
operation. `canCommitVerifiedDirectMessagingLink` supplies the comparison predicate
for use inside that transaction. Invalid tokens and foreign accounts must not burn
valid challenges. Concurrent redemption must have one winner.

Only links with `verifiedAt` set by that operation should authorize activity reads.
Previously stored unverified links require relinking. Dashboard routes may revoke
links but must not call the older generic consume/create operations to establish
sender ownership. Do not log link commands, tokens or webhook bodies.

This verifies sender possession; reliable inbox processing, delivery retries,
quotas and provider activation validation remain separate host requirements.

## Opt-in reply delivery

`prepareDirectMessagingReply` records the authorized creator scope alongside the
reply and limits delivery to 15 minutes from the signed provider event timestamp.
This is application freshness policy. Missing/future timestamps and legacy
outbox entries without delivery context cannot authorize a send.

`createDirectMessagingDeliveryWorker` processes one reply per tick without
overlapping ticks. It checks the instance/account, expiry, current sender link
and current creator permission before sending. Hosts control the tick interval,
credentials and supported Graph API version. Public help/link replies contain no
creator activity and can be sent without a creator link.

HTTP 429 responses schedule exponential backoff with Retry-After and a five-attempt
limit. Other 4xx responses fail; network failures, malformed success responses and
5xx responses remain uncertain and are not automatically retried. Failure to
persist a successful send is not converted into a retry. Durable host adapters
must recover abandoned sending claims as uncertain, never pending. Synthetic
provider tests cover these boundaries; no live provider validation is claimed.

ES/NF local composition enables sending only with `WHATSAPP_DELIVERY_ENABLED=true`,
the receiver settings, `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_GRAPH_API_VERSION`.
It ticks every five seconds. This does not activate hosted deployment, dashboard
UI or durable recovery of messages interrupted before outbox creation. Meta's
current documentation returned HTTP 429 during this implementation; current
provider requirements remain an activation gate.

## Protocol references

- https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
- https://developers.facebook.com/docs/graph-api/webhooks/getting-started

These documentation pages could not be fetched during implementation (access/rate-limit errors). The included tests use synthetic protocol fixtures; live provider validation is an activation gate, not a claimed test result.
