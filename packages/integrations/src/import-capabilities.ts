/** Semantic action names are additive; legacy persisted operation identifiers remain valid. */
export const INTEGRATION_IMPORT_LABELS = {
  published_works: "Import Published Works",
  announcements: "Import Announcements",
  raw_files: "Import files",
} as const;
export type IntegrationImportAction = keyof typeof INTEGRATION_IMPORT_LABELS;
export type IntegrationImportSupport =
  | "implemented"
  | "unsupported"
  | "not_implemented";
export type IntegrationImportReadinessState =
  | "ready"
  | "authorization_required"
  | "source_selection_required"
  | "temporarily_unavailable";
export interface IntegrationImportCapability {
  action: IntegrationImportAction;
  label: (typeof INTEGRATION_IMPORT_LABELS)[IntegrationImportAction];
  support: IntegrationImportSupport;
  description: string;
  sourceTypes: readonly string[];
  restrictions: readonly string[];
  filters: {
    dates: boolean;
    authors: boolean;
    attachments: boolean;
    boundedPagination: boolean;
  };
  connectionModes: readonly string[];
  requiredPermissions: readonly string[];
}
export type IntegrationImportCapabilities = Record<
  IntegrationImportAction,
  IntegrationImportCapability
>;
export interface IntegrationImportReadiness {
  action: IntegrationImportAction;
  support: IntegrationImportSupport;
  state: IntegrationImportReadinessState;
  enabled: boolean;
  reason?: string;
}
/** Evaluate from current server/provider observations, never request-body permission assertions. */
export function integrationImportReadiness(
  capability: IntegrationImportCapability,
  connection: {
    mode: string;
    authorized: boolean;
    permissions: readonly string[];
    sourceSelected: boolean;
    temporarilyUnavailable?: boolean;
    hostEnabled: boolean;
  },
): IntegrationImportReadiness {
  const result = (
    state: IntegrationImportReadinessState,
    reason?: string,
  ): IntegrationImportReadiness => ({
    action: capability.action,
    support: capability.support,
    state,
    enabled: state === "ready",
    ...(reason ? { reason } : {}),
  });
  if (capability.support !== "implemented")
    return result(
      "temporarily_unavailable",
      capability.support === "not_implemented"
        ? "This import action is not yet implemented."
        : "This source does not support this import action.",
    );
  if (!connection.hostEnabled || connection.temporarilyUnavailable)
    return result(
      "temporarily_unavailable",
      "Import is currently unavailable in this deployment.",
    );
  if (!capability.connectionModes.includes(connection.mode))
    return result(
      "authorization_required",
      "Use a connection mode with authorized history retrieval; an outgoing webhook is not a channel-history connection.",
    );
  if (
    !connection.authorized ||
    capability.requiredPermissions.some(
      (permission) => !connection.permissions.includes(permission),
    )
  )
    return result(
      "authorization_required",
      "Additional source authorization or history/content permissions are required.",
    );
  if (!connection.sourceSelected)
    return result(
      "source_selection_required",
      "Select an authorized source before importing.",
    );
  return result("ready");
}

export interface AnnouncementImportScope {
  from: string;
  to: string;
  sourceIds: readonly string[];
  authorIds: readonly string[];
  includeAttachments: boolean;
  includeAttributedMaterial: boolean;
  includeMetadataOnly: boolean;
  limits: { pages: number; candidates: number; elapsedMilliseconds: number };
}
export function validateAnnouncementImportScope(
  scope: AnnouncementImportScope,
): void {
  const from = Date.parse(scope.from),
    to = Date.parse(scope.to),
    bounded = (value: number, maximum: number) =>
      Number.isSafeInteger(value) && value > 0 && value <= maximum;
  const ids = (values: readonly string[], maximum: number) =>
    Array.isArray(values) &&
    values.length > 0 &&
    values.length <= maximum &&
    values.every(
      (value) =>
        typeof value === "string" &&
        Boolean(value.trim()) &&
        value.length <= 500,
    ) &&
    new Set(values).size === values.length;
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from >= to ||
    to - from > 366 * 86400000 ||
    !ids(scope.sourceIds, 25) ||
    !ids(scope.authorIds, 100) ||
    !bounded(scope.limits.pages, 100) ||
    !bounded(scope.limits.candidates, 1000) ||
    !bounded(scope.limits.elapsedMilliseconds, 300000) ||
    [
      scope.includeAttachments,
      scope.includeAttributedMaterial,
      scope.includeMetadataOnly,
    ].some((value) => typeof value !== "boolean")
  )
    throw new Error(
      "Announcement imports require explicit bounded sources, authors, dates and execution limits.",
    );
}
export type AnnouncementImportOutcome =
  | "created"
  | "reconciled"
  | "unchanged"
  | "skipped"
  | "partial"
  | "failed";
export interface AnnouncementImportCandidateOutcome {
  sourceKey: string;
  outcome: AnnouncementImportOutcome;
  reason?: string;
  announcementId?: string;
  publicationId?: string;
  historyRecordId?: string;
  attachmentOutcomes: readonly {
    attachmentId: string;
    state: "archived" | "failed" | "excluded" | "not_requested";
    reason?: string;
  }[];
}
export interface AnnouncementImportJob {
  id: string;
  tenantId: string;
  ownerId: string;
  requestedByUserId: string;
  connectionId: string;
  importType: "announcements";
  scope: AnnouncementImportScope;
  status:
    | "queued"
    | "running"
    | "paused"
    | "completed"
    | "cancelled"
    | "failed";
  checkpoint: {
    sourceId: string;
    cursor?: string;
    pages: number;
    candidates: number;
  };
  counts: Record<AnnouncementImportOutcome, number>;
  nextAttemptAt?: string;
  reason?: string;
  /** Cancellation preserves all previously committed source/entity/media associations. */
  cancellationRequestedAt?: string;
}
/** Server-stored preview binding. Adapters must use an opaque random token or authenticated envelope. */
export interface AnnouncementImportPreviewBinding {
  id: string;
  tenantId: string;
  ownerId: string;
  requestedByUserId: string;
  connectionId: string;
  authorizationRevision: string;
  scope: AnnouncementImportScope;
  candidateSourceKeys: readonly string[];
  expiresAt: string;
}
export function requireAnnouncementImportPreview(
  binding: AnnouncementImportPreviewBinding,
  expected: {
    tenantId: string;
    ownerId: string;
    requestedByUserId: string;
    connectionId: string;
    authorizationRevision: string;
    selectedSourceKeys: readonly string[];
    now?: Date;
  },
): void {
  validateAnnouncementImportScope(binding.scope);
  const fields = [
    "tenantId",
    "ownerId",
    "requestedByUserId",
    "connectionId",
    "authorizationRevision",
  ] as const;
  if (
    !binding.id ||
    fields.some(
      (field) => !binding[field] || binding[field] !== expected[field],
    ) ||
    !Number.isFinite(Date.parse(binding.expiresAt)) ||
    !Number.isFinite((expected.now ?? new Date()).getTime()) ||
    Date.parse(binding.expiresAt) <= (expected.now ?? new Date()).getTime() ||
    !Array.isArray(expected.selectedSourceKeys) ||
    !expected.selectedSourceKeys.length ||
    expected.selectedSourceKeys.length > binding.scope.limits.candidates ||
    new Set(expected.selectedSourceKeys).size !==
      expected.selectedSourceKeys.length ||
    expected.selectedSourceKeys.some(
      (key) => !binding.candidateSourceKeys.includes(key),
    )
  )
    throw new Error(
      "The import preview is expired, changed or outside the authorized scope.",
    );
}
