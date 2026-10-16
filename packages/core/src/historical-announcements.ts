/** Import history is a private observation, independent of an outbound delivery lifecycle. */
export interface ImportedSourceIdentity {
  tenantId: string;
  ownerId: string;
  provider: string;
  providerOrigin: string;
  containers: readonly { kind: string; id: string }[];
  remoteId: string;
}
export type SourceAttributionKind =
  | "original"
  | "reblog"
  | "forwarded"
  | "reply"
  | "system";
export interface ImportedSourceAttribution {
  authorId: string;
  displayName: string;
  kind: SourceAttributionKind;
  originalAuthorId?: string;
  originalAuthorName?: string;
}
export interface HistoricalContentBlock {
  /** Plain text only; render through text nodes. Do not interpret mentions or HTML. */
  kind: "text" | "link" | "attachment" | "embed" | "unsupported";
  text?: string;
  url?: string;
  attachmentId?: string;
  reason?: string;
}
export interface HistoricalAttachment {
  id: string;
  position: number;
  kind: "source_attachment" | "embed_preview";
  mediaType: "image" | "video" | "audio" | "file" | "unknown";
  /** An unsigned, durable reference only. Retrieval credentials and expiring URLs stay outside snapshots. */
  sourceUrl?: string;
  altText?: string;
  mimeType?: string;
  filename?: string;
  bytes?: number;
  archive: "not_requested" | "pending" | "archived" | "failed" | "excluded";
  /** Set only after managed ingestion has committed a private, authorized asset. */
  managedAssetId?: string;
  reason?: string;
}
export interface HistoricalContentSnapshot {
  blocks: readonly HistoricalContentBlock[];
  attachments: readonly HistoricalAttachment[];
  layout: readonly {
    kind: "rows" | "carousel";
    blockIndexes: readonly number[];
  }[];
  links: readonly string[];
  tags: readonly string[];
}
export interface ImportedSourcePost {
  identity: ImportedSourceIdentity;
  connectionId: string;
  sourceUrl?: string;
  attribution: ImportedSourceAttribution;
  /** Unknown source dates stay null; importing must not manufacture a posting date. */
  postedAt: string | null;
  remoteEditedAt: string | null;
  firstImportedAt: string;
  lastObservedAt: string;
  snapshot: HistoricalContentSnapshot;
  contentHash: string;
  restrictions: {
    visibility: "public" | "restricted" | "unknown";
    scopeIds: readonly string[];
    reasons: readonly string[];
  };
  completeness: "full" | "partial" | "metadata_only" | "unavailable";
  reasons: readonly string[];
  provenance: {
    jobId: string;
    adapterVersion: string;
    normalizerVersion: string;
    mapping: "announcement_import";
  };
}
export interface HistoricalRelationship {
  type: "work" | "collection";
  id: string;
  evidence: "retained_publication" | "canonical_url" | "explicit_selection";
}
export interface HistoricalAnnouncement {
  id: string;
  tenantId: string;
  ownerId: string;
  origin: "external_import";
  externalState: "posted";
  lifecycle: "historical";
  visibility: "private";
  /** Local presentation is distinct from the latest observed source snapshot. */
  content: HistoricalContentSnapshot;
  localEditedAt: string | null;
  relationships: readonly HistoricalRelationship[];
  createdAt: string;
  updatedAt: string;
}
/** Proven existing outbound records can be associated without modifying or resending their content. */
export interface TrackedOutboundAnnouncement {
  id: string;
  tenantId: string;
  ownerId: string;
  origin: "local";
  lifecycle: "outbound";
  content: HistoricalContentSnapshot;
  localEditedAt: string | null;
}
export interface HistoricalSourceAssociation {
  sourceKey: string;
  tenantId: string;
  ownerId: string;
  target: {
    type: "announcement" | "work_publication" | "collection_publication";
    id: string;
  };
}

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && Boolean(value.trim()) && value.length <= 1000;
const date = (value: string | null): boolean =>
  value === null ||
  (typeof value === "string" && Number.isFinite(Date.parse(value)));
const origin = (value: string): string => {
  const parsed = new URL(value);
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  )
    throw new Error(
      "A provider origin must be an HTTP(S) origin without credentials.",
    );
  return parsed.origin;
};
/** Stable across reconnections. Adapters must enforce scoped database uniqueness for this tuple. */
export function importedSourceKey(identity: ImportedSourceIdentity): string {
  if (
    ![
      identity.tenantId,
      identity.ownerId,
      identity.provider,
      identity.remoteId,
    ].every(nonempty) ||
    !Array.isArray(identity.containers) ||
    !identity.containers.length ||
    identity.containers.length > 8 ||
    identity.containers.some(
      (container) => !nonempty(container.kind) || !nonempty(container.id),
    ) ||
    new Set(identity.containers.map((c) => c.kind)).size !==
      identity.containers.length
  )
    throw new Error("Invalid imported source identity.");
  return JSON.stringify([
    identity.tenantId,
    identity.ownerId,
    identity.provider,
    origin(identity.providerOrigin),
    [...identity.containers]
      .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
      .map((c) => [c.kind, c.id]),
    identity.remoteId,
  ]);
}
/** Public video identifiers/timestamps are not access credentials. Other query parameters stay out of historical snapshots. */
export function historicalPublicQueryParameter(
  host: string,
  path: string,
  key: string,
  value: string,
): boolean {
  if (
    !["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(
      host,
    )
  )
    return false;
  if (
    host === "youtu.be"
      ? !/^\/[a-zA-Z0-9_-]{11}$/.test(path)
      : !["/watch", "/playlist"].includes(path)
  )
    return false;
  return key === "v"
    ? /^[a-zA-Z0-9_-]{11}$/.test(value)
    : key === "t"
      ? /^[0-9hms]{1,20}$/.test(value)
      : ["list", "index"].includes(key) && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}
/** Snapshot references are never delivery authorizations. Signed URLs cannot be persisted here. */
const safeUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.search ||
        Array.from(url.searchParams).every(([key, value]) =>
          historicalPublicQueryParameter(
            url.hostname,
            url.pathname,
            key,
            value,
          ),
        )) &&
      !url.hash
    );
  } catch {
    return false;
  }
};
export function validateHistoricalSnapshot(
  snapshot: HistoricalContentSnapshot,
): void {
  const only = (value: object, fields: readonly string[]) =>
    Object.keys(value).every((key) => fields.includes(key));
  if (
    !snapshot ||
    !only(snapshot, ["blocks", "attachments", "layout", "links", "tags"]) ||
    new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 524288
  )
    throw new Error(
      "Historical snapshots must contain only bounded normalized content.",
    );
  if (
    !Array.isArray(snapshot.blocks) ||
    snapshot.blocks.length > 100 ||
    !Array.isArray(snapshot.attachments) ||
    snapshot.attachments.length > 50 ||
    !Array.isArray(snapshot.links) ||
    snapshot.links.length > 100 ||
    !Array.isArray(snapshot.tags) ||
    snapshot.tags.length > 100 ||
    !Array.isArray(snapshot.layout) ||
    snapshot.layout.length > 100
  )
    throw new Error("Historical content exceeds snapshot bounds.");
  const ids = new Set<string>(),
    positions = new Set<number>();
  for (const attachment of snapshot.attachments) {
    if (
      !only(attachment, [
        "id",
        "position",
        "kind",
        "mediaType",
        "sourceUrl",
        "altText",
        "mimeType",
        "filename",
        "bytes",
        "archive",
        "managedAssetId",
        "reason",
      ]) ||
      !nonempty(attachment.id) ||
      ids.has(attachment.id) ||
      !Number.isSafeInteger(attachment.position) ||
      attachment.position < 0 ||
      positions.has(attachment.position) ||
      !["source_attachment", "embed_preview"].includes(attachment.kind) ||
      !["image", "video", "audio", "file", "unknown"].includes(
        attachment.mediaType,
      ) ||
      !["not_requested", "pending", "archived", "failed", "excluded"].includes(
        attachment.archive,
      ) ||
      (attachment.sourceUrl !== undefined && !safeUrl(attachment.sourceUrl)) ||
      (attachment.archive === "archived"
        ? !nonempty(attachment.managedAssetId)
        : attachment.managedAssetId !== undefined) ||
      (attachment.bytes !== undefined &&
        (!Number.isSafeInteger(attachment.bytes) || attachment.bytes < 0))
    )
      throw new Error("Invalid historical attachment.");
    ids.add(attachment.id);
    positions.add(attachment.position);
  }
  for (const block of snapshot.blocks) {
    if (
      !only(block, ["kind", "text", "url", "attachmentId", "reason"]) ||
      !["text", "link", "attachment", "embed", "unsupported"].includes(
        block.kind,
      ) ||
      (block.text !== undefined &&
        (typeof block.text !== "string" || block.text.length > 100000)) ||
      (block.url !== undefined && !safeUrl(block.url)) ||
      (block.attachmentId !== undefined && !ids.has(block.attachmentId)) ||
      (block.kind === "attachment" && !block.attachmentId) ||
      (block.kind === "unsupported" && !nonempty(block.reason))
    )
      throw new Error("Invalid historical content block.");
  }
  if (
    snapshot.links.some((link) => !safeUrl(link)) ||
    snapshot.tags.some((tag) => typeof tag !== "string" || tag.length > 200) ||
    snapshot.layout.some(
      (row) =>
        !only(row, ["kind", "blockIndexes"]) ||
        !["rows", "carousel"].includes(row.kind) ||
        !Array.isArray(row.blockIndexes) ||
        row.blockIndexes.length > 100 ||
        row.blockIndexes.some(
          (index: number) =>
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= snapshot.blocks.length,
        ),
    )
  )
    throw new Error("Invalid historical links or layout.");
}
export function validateImportedSourcePost(source: ImportedSourcePost): void {
  importedSourceKey(source.identity);
  validateHistoricalSnapshot(source.snapshot);
  const only = (value: object, fields: readonly string[]) =>
    Object.keys(value).every((key) => fields.includes(key));
  const strings = (values: readonly string[]) =>
    Array.isArray(values) &&
    values.length <= 100 &&
    values.every((value) => typeof value === "string" && value.length <= 1000);
  if (
    !only(source, [
      "identity",
      "connectionId",
      "sourceUrl",
      "attribution",
      "postedAt",
      "remoteEditedAt",
      "firstImportedAt",
      "lastObservedAt",
      "snapshot",
      "contentHash",
      "restrictions",
      "completeness",
      "reasons",
      "provenance",
    ]) ||
    !only(source.identity, [
      "tenantId",
      "ownerId",
      "provider",
      "providerOrigin",
      "containers",
      "remoteId",
    ]) ||
    source.identity.containers.some((value) => !only(value, ["kind", "id"])) ||
    !only(source.attribution, [
      "authorId",
      "displayName",
      "kind",
      "originalAuthorId",
      "originalAuthorName",
    ]) ||
    typeof source.attribution.displayName !== "string" ||
    source.attribution.displayName.length > 1000 ||
    [
      source.attribution.originalAuthorId,
      source.attribution.originalAuthorName,
    ].some(
      (value) =>
        value !== undefined &&
        (typeof value !== "string" || value.length > 1000),
    ) ||
    !only(source.restrictions, ["visibility", "scopeIds", "reasons"]) ||
    !strings(source.restrictions.scopeIds) ||
    !strings(source.restrictions.reasons) ||
    !strings(source.reasons) ||
    !only(source.provenance, [
      "jobId",
      "adapterVersion",
      "normalizerVersion",
      "mapping",
    ])
  )
    throw new Error(
      "Source records must contain only bounded normalized provenance.",
    );
  if (
    ![
      source.connectionId,
      source.attribution.authorId,
      source.contentHash,
      source.provenance.jobId,
      source.provenance.adapterVersion,
      source.provenance.normalizerVersion,
    ].every(nonempty) ||
    !date(source.postedAt) ||
    !date(source.remoteEditedAt) ||
    !date(source.firstImportedAt) ||
    !date(source.lastObservedAt) ||
    source.firstImportedAt === null ||
    source.lastObservedAt === null ||
    (source.sourceUrl !== undefined && !safeUrl(source.sourceUrl)) ||
    !["original", "reblog", "forwarded", "reply", "system"].includes(
      source.attribution.kind,
    ) ||
    !["public", "restricted", "unknown"].includes(
      source.restrictions.visibility,
    ) ||
    !["full", "partial", "metadata_only", "unavailable"].includes(
      source.completeness,
    ) ||
    source.provenance.mapping !== "announcement_import"
  )
    throw new Error("Invalid imported source observation.");
}
export type HistoricalImportDecision =
  | {
      kind: "skip";
      reason:
        | "source_excluded"
        | "author_excluded"
        | "source_unavailable"
        | "metadata_selection_required"
        | "source_restriction";
    }
  | {
      kind: "reconcile_publication";
      association: HistoricalSourceAssociation;
      message: "Already tracked as a publication";
    }
  | {
      kind: "reconcile_announcement";
      association: HistoricalSourceAssociation;
      update: "unchanged" | "refresh_local" | "review_source_change";
      announcement: HistoricalAnnouncement | TrackedOutboundAnnouncement;
    }
  | {
      kind: "create_announcement";
      announcement: HistoricalAnnouncement;
      association: HistoricalSourceAssociation;
    };

/** A pure plan only. Caller loads authorities and matches server-side and commits the source/entity association atomically. */
export function planHistoricalAnnouncementImport(input: {
  source: ImportedSourcePost;
  announcementId: string;
  sourceAuthorized: boolean;
  authorAuthorized: boolean;
  restrictionsRepresentable: boolean;
  includeAttributedMaterial?: boolean;
  includeMetadataOnly?: boolean;
  excluded?: boolean;
  restoreExcluded?: boolean;
  existingPublication?: HistoricalSourceAssociation;
  existingAnnouncement?: {
    association: HistoricalSourceAssociation;
    announcement: HistoricalAnnouncement | TrackedOutboundAnnouncement;
    observedContentHash: string;
  };
  /** Only server-resolved, authorized relationships; fuzzy suggestions are not accepted. */
  relationships?: readonly HistoricalRelationship[];
}): HistoricalImportDecision {
  const { source } = input;
  validateImportedSourcePost(source);
  const sourceKey = importedSourceKey(source.identity),
    { tenantId, ownerId } = source.identity;
  if (!input.sourceAuthorized || !input.authorAuthorized)
    return { kind: "skip", reason: "author_excluded" };
  if (!input.restrictionsRepresentable)
    return { kind: "skip", reason: "source_restriction" };
  if (input.excluded && !input.restoreExcluded)
    return { kind: "skip", reason: "source_excluded" };
  const requireAssociation = (association: HistoricalSourceAssociation) => {
    if (
      association.sourceKey !== sourceKey ||
      association.tenantId !== tenantId ||
      association.ownerId !== ownerId ||
      !nonempty(association.target.id)
    )
      throw new Error(
        "Imported source association is outside its owner scope.",
      );
  };
  // Proven outbound identity wins over default classification, regardless of media or caption.
  if (input.existingPublication) {
    requireAssociation(input.existingPublication);
    if (
      !["work_publication", "collection_publication"].includes(
        input.existingPublication.target.type,
      )
    )
      throw new Error("Expected a proven publication association.");
    return {
      kind: "reconcile_publication",
      association: input.existingPublication,
      message: "Already tracked as a publication",
    };
  }
  if (source.completeness === "unavailable")
    return { kind: "skip", reason: "source_unavailable" };
  if (source.completeness === "metadata_only" && !input.includeMetadataOnly)
    return { kind: "skip", reason: "metadata_selection_required" };
  if (
    ["reply", "system"].includes(source.attribution.kind) ||
    (source.attribution.kind !== "original" && !input.includeAttributedMaterial)
  )
    return { kind: "skip", reason: "author_excluded" };
  if (input.existingAnnouncement) {
    const previous = input.existingAnnouncement;
    requireAssociation(previous.association);
    const announcement = previous.announcement;
    if (
      previous.association.target.type !== "announcement" ||
      previous.association.target.id !== announcement.id ||
      announcement.ownerId !== ownerId ||
      announcement.tenantId !== tenantId ||
      (announcement.origin === "external_import"
        ? announcement.lifecycle !== "historical" ||
          announcement.visibility !== "private"
        : announcement.origin !== "local" ||
          announcement.lifecycle !== "outbound")
    )
      throw new Error("Invalid historical Announcement association.");
    const update =
      previous.observedContentHash === source.contentHash
        ? "unchanged"
        : announcement.origin === "local" || announcement.localEditedAt !== null
          ? "review_source_change"
          : "refresh_local";
    return {
      kind: "reconcile_announcement",
      association: previous.association,
      update,
      announcement:
        update === "refresh_local" && announcement.origin === "external_import"
          ? {
              ...announcement,
              content: structuredClone(source.snapshot),
              updatedAt: source.lastObservedAt,
            }
          : structuredClone(announcement),
    };
  }
  if (!nonempty(input.announcementId))
    throw new Error("A historical Announcement ID is required.");
  const relationships = input.relationships ?? [];
  if (
    relationships.length > 100 ||
    relationships.some(
      (item) =>
        !nonempty(item.id) ||
        !["work", "collection"].includes(item.type) ||
        ![
          "retained_publication",
          "canonical_url",
          "explicit_selection",
        ].includes(item.evidence),
    )
  )
    throw new Error(
      "Relationships require explicit authorized mapping evidence.",
    );
  const announcement: HistoricalAnnouncement = {
    id: input.announcementId,
    tenantId,
    ownerId,
    origin: "external_import",
    externalState: "posted",
    lifecycle: "historical",
    visibility: "private",
    content: structuredClone(source.snapshot),
    localEditedAt: null,
    relationships: structuredClone(relationships),
    createdAt: source.firstImportedAt,
    updatedAt: source.lastObservedAt,
  };
  return {
    kind: "create_announcement",
    announcement,
    association: {
      sourceKey,
      tenantId,
      ownerId,
      target: { type: "announcement", id: announcement.id },
    },
  };
}

/** Hash only observed content. Reconnection, job IDs and observation timestamps are not content changes. */
export async function historicalSourceContentHash(
  source: Pick<
    ImportedSourcePost,
    | "sourceUrl"
    | "attribution"
    | "postedAt"
    | "remoteEditedAt"
    | "snapshot"
    | "restrictions"
    | "completeness"
    | "reasons"
  >,
): Promise<string> {
  validateHistoricalSnapshot(source.snapshot);
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  const snapshot = {
    ...source.snapshot,
    attachments: source.snapshot.attachments.map(
      ({
        archive: _archive,
        managedAssetId: _managed,
        reason: _reason,
        ...attachment
      }) => attachment,
    ),
  };
  const payload = canonical({
    sourceUrl: source.sourceUrl,
    attribution: source.attribution,
    postedAt: source.postedAt,
    remoteEditedAt: source.remoteEditedAt,
    snapshot,
    restrictions: source.restrictions,
    completeness: source.completeness,
    reasons: source.reasons,
  });
  return Array.from(
    new Uint8Array(
      await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(payload)),
      ),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
