# Integration imports: Published Works and Announcements

## Semantic actions and compatibility

`catalogue_import` and the `import` operation keep their existing serialized
meaning and behavior. `source_migration` remains source-media copying. The new
`announcement_import` capability and `import_announcements` operation are
independent. Display semantic actions through `INTEGRATION_IMPORT_LABELS`:

| Action | Label |
| --- | --- |
| published_works | Import Published Works |
| announcements | Import Announcements |
| raw_files | Import files |

Do not label raw storage as published creative content. `IntegrationImportCapability`
describes implemented/unsupported/not-implemented adapter support, source types,
filters, required modes/permissions and restrictions. `integrationImportReadiness`
separately evaluates current connection authorization, source selection, host
activation and temporary unavailability. An outgoing webhook is not a general
channel-history connection. A send capability never implies an import capability.

## History contracts

`ImportedSourceIdentity` keys tenant, owner context, provider origin, stable
containers and string remote ID. `importedSourceKey` deliberately excludes
connection IDs; reconnecting cannot create a different source identity. Adapters
must enforce database uniqueness for this key and each source/entity association,
and atomically commit observations, entities, media outcomes and job progress.
The pure planner is not a persistence lock or a complete import service.

`HistoricalAnnouncement` has `origin=external_import`, `externalState=posted`,
`lifecycle=historical` and private visibility. It has no outbound draft/send state.
Zero Works/Collections is valid. Several image attachments still describe one
Announcement. Observed source snapshots and local editable content are distinct.
Original posting/edit dates are nullable and separate from first-import and last-
observation times. Unknown dates must not be replaced with an import date.

`planHistoricalAnnouncementImport` gives proven Work/Collection publications
precedence over default mapping, reconciles existing Announcement associations,
keeps unchanged observations as no-ops, refreshes untouched local representations,
and preserves local edits for source-change review. Existing outbound Announcements
are associated without modifying their content or scheduling another delivery.
Relationship evidence is limited to retained publication IDs, recognized canonical
URLs and explicit authorized selections. No caption/image similarity inference.

Core validators accept bounded normalized blocks, attachments, layouts and metadata,
not raw provider payloads. Text is plain text, never trusted HTML or a mention
instruction. Historical content hashes exclude connection/job IDs, observation time,
and local attachment-archiving outcomes. Raw/signed retrieval URLs belong only to
an ephemeral adapter result, outside stored snapshots. Public canonical URLs and
explicitly allowed public video query identifiers can be retained; unknown query
parameters/fragments are removed with partial-content warnings. Adapters remain
responsible for keeping all credentials outside normalized text and payloads.

## Shared normalization and execution

`normalizeTumblrHistoricalPost` handles published NPF and legacy representations,
ordered media, supported row/carousel layouts, safe links, tags, reblog attribution
and trails. Unsupported/truncated content is partial. Unsafe numeric post IDs are
rejected; `id_string` is preferred. Draft/queue/private states are unavailable to
this flow. Public retrieval alone is never source ownership authorization.

`normalizeDiscordHistoricalMessage` retains guild/channel/message IDs, author or
webhook identity, dates, ordered attachments and supported embed metadata. It marks
replies, forwards, system messages and crosspost fan-out distinctly, and marks hidden
content fields unavailable. `discordHistoryPermissions` evaluates View Channel and
Read Message History through current guild roles and channel/member overwrites;
it grants no authority over arbitrary authors.

`AnnouncementImportScope`, preview bindings, jobs and per-candidate outcomes provide
bounded dates/sources/authors, page/item/time budgets, scoped expiring selections,
resumable checkpoints and distinct created/reconciled/unchanged/skipped/partial/
failed counts. A host must implement durable opaque preview tokens or authenticated
envelopes, current authorization checks before execution, source deduplication,
rate-limit cooldown/backoff, lease fencing, cancellation and private managed media.
Cancellation preserves already committed items. Page absence never means deletion.

## Adapter/host requirements

- Select only live connection-authorized blogs/channels and proven or delegated
  author identities. Scope to current owner permissions; do not infer creative
  ownership from blog/server administration.
- Keep imported content private; use importer-only storage if source restrictions
  cannot safely become team-wide. No public media URLs, feeds, indexing, follower
  notifications or outgoing publish/send listeners.
- Download only within the selected scope through normal host URL/DNS, deadline,
  size/type, quota and policy controls. Distinguish third-party previews from source
  attachments, never call a remote URL an archived asset, and retry media separately.
- Recheck source access on explicit reruns; preserve local edits and bounded observed
  versions. Apply source/host retention, observed access-loss cleanup, credential
  deletion on disconnect and scoped local exclusion/explicit reimport markers.
- Use existing owner abstractions. This feature does not create organizations or
  activate another downstream product. Continuous synchronization and Create Work
  from this post remain separate future actions.

## Provider references checked 2026-10-15

- [Tumblr official API](https://github.com/tumblr/docs/blob/master/api.md#posts--retrieve-published-posts)
- [Tumblr NPF](https://github.com/tumblr/docs/blob/master/npf-spec.md)
- [Discord message resource](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx)
- [Discord Gateway intents](https://docs.discord.com/developers/events/gateway#message-content-intent)
- [Discord application flags](https://docs.discord.com/developers/resources/application#application-object-application-flags)
- [Known webhook-message retrieval](https://docs.discord.com/developers/resources/webhook#get-webhook-message)

These references establish retrieval constraints. Domain classification and rollout
remain host/product decisions; the shared package performs no publishing side effects.
