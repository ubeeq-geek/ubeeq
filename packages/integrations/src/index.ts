/** Product-neutral remote integration capabilities. */
export const INTEGRATION_CAPABILITIES = [
  "connect", "catalogue_import", "source_migration", "publish", "remote_update",
  "remote_delete", "engagement_read", "engagement_write", "webhook_receive", "reconcile"
] as const;
export type IntegrationCapability = (typeof INTEGRATION_CAPABILITIES)[number];

export type IntegrationOperation =
  | "connect"
  | "import"
  | "migrate_source"
  | "publish"
  | "update_remote"
  | "delete_remote"
  | "read_engagement"
  | "write_engagement"
  | "receive_webhook"
  | "reconcile";

export interface IntegrationDefinition {
  id: string;
  capabilities: readonly IntegrationCapability[];
  credentialCustody: "application" | "isolated_broker";
  ownerModel: "creator" | "user" | "workspace";
  connectionModel: "external_account" | "native_connection";
}

const requiredCapability: Record<IntegrationOperation, IntegrationCapability> = {
  connect: "connect", import: "catalogue_import", migrate_source: "source_migration", publish: "publish",
  update_remote: "remote_update", delete_remote: "remote_delete", read_engagement: "engagement_read",
  write_engagement: "engagement_write", receive_webhook: "webhook_receive", reconcile: "reconcile"
};

export const supportsIntegrationOperation = (definition: IntegrationDefinition, operation: IntegrationOperation): boolean =>
  definition.capabilities.includes(requiredCapability[operation]);

export class UnsupportedIntegrationOperationError extends Error {
  constructor(readonly integrationId: string, readonly operation: IntegrationOperation) {
    super(`Integration ${integrationId} does not support ${operation}.`);
    this.name = "UnsupportedIntegrationOperationError";
  }
}

export const requireIntegrationOperation = (definition: IntegrationDefinition, operation: IntegrationOperation): void => {
  if (!supportsIntegrationOperation(definition, operation)) throw new UnsupportedIntegrationOperationError(definition.id, operation);
};

export const integrationConformanceScenarios = [
  "oauth-expiry", "pagination", "rate-limit-backoff", "duplicate-retry",
  "remote-deletion", "unsupported-fields", "reconciliation"
] as const;
export type IntegrationConformanceScenario = typeof integrationConformanceScenarios[number];

export interface IntegrationConformanceEvidence { assertions: number; summary: string; }
export interface IntegrationConformanceAdapter {
  integrationId: string;
  scenarios: Record<IntegrationConformanceScenario, () => Promise<IntegrationConformanceEvidence>>;
}

export const runIntegrationConformanceSuite = async (adapter: IntegrationConformanceAdapter): Promise<void> => {
  for (const scenario of integrationConformanceScenarios) {
    const evidence = await adapter.scenarios[scenario]();
    if (!Number.isInteger(evidence?.assertions) || evidence.assertions < 1 || !evidence.summary.trim()) {
      throw new Error(`${adapter.integrationId} conformance scenario ${scenario} did not report executable assertions.`);
    }
  }
};

export type RemotePublicationState = "active" | "missing" | "restricted" | "deleted" | "unknown";
export type RemotePublicationStatus = "draft" | "scheduled" | "queued" | "publishing" | "live" | "updating" | "failed" | "missing" | "removed" | "unknown";
export type RemotePublicationSyncStatus = "not_applicable" | "in_sync" | "local_newer" | "remote_newer" | "conflict" | "error" | "unknown";

export interface RemotePublicationRecord {
  status: RemotePublicationStatus;
  sync: {
    status: RemotePublicationSyncStatus;
    remoteCursor?: string;
    remoteMetadataFingerprint?: string;
    remoteContentFingerprint?: string;
    remoteState?: "active" | "missing" | "restricted" | "unknown";
    lastSuccessfulAt?: string;
    errorCode?: string;
    errorMessage?: string;
    retry?: { idempotencyKey: string; attempt: number; nextAttemptAt?: string; connectionCooldownUntil?: string };
  };
  updatedAt: string;
}

export const publicationStatusForRemoteState = (state: RemotePublicationState): RemotePublicationStatus =>
  state === "missing" ? "missing" : state === "deleted" ? "removed" : "unknown";

export const syncStatusForRemoteState = (state: RemotePublicationState): RemotePublicationSyncStatus =>
  state === "active" ? "in_sync" : state === "unknown" ? "unknown" : "remote_newer";

/** Records one normalized remote observation without exposing provider payloads in the common contract. */
export const recordRemotePublicationState = <T extends RemotePublicationRecord>(
  publication: T,
  state: RemotePublicationState,
  input: { cursor?: string; metadataFingerprint?: string; contentFingerprint?: string; observedAt?: string; reason?: string }
): T => {
  const observedAt = input.observedAt || new Date().toISOString();
  return {
    ...publication,
    ...(state === "active" ? {} : { status: publicationStatusForRemoteState(state) }),
    sync: {
      ...publication.sync,
      status: syncStatusForRemoteState(state),
      remoteCursor: input.cursor || publication.sync.remoteCursor,
      remoteMetadataFingerprint: input.metadataFingerprint || publication.sync.remoteMetadataFingerprint,
      remoteContentFingerprint: input.contentFingerprint || publication.sync.remoteContentFingerprint,
      remoteState: state === "deleted" ? "missing" : state,
      ...(state === "active"
        ? { lastSuccessfulAt: observedAt, errorCode: undefined, errorMessage: undefined }
        : { errorCode: `REMOTE_${state.toUpperCase()}`, errorMessage: input.reason })
    },
    updatedAt: observedAt
  } as T;
};

/** Preserves one idempotency key and does not discard an existing connection-wide cooldown. */
export const scheduleRemotePublicationRetry = <T extends RemotePublicationRecord>(
  publication: T,
  input: { idempotencyKey: string; nextAttemptAt?: string; connectionCooldownUntil?: string; now?: string }
): T => ({
  ...publication,
  sync: {
    ...publication.sync,
    retry: {
      idempotencyKey: publication.sync.retry?.idempotencyKey || input.idempotencyKey,
      attempt: (publication.sync.retry?.attempt || 0) + 1,
      nextAttemptAt: input.nextAttemptAt ?? publication.sync.retry?.nextAttemptAt,
      connectionCooldownUntil: input.connectionCooldownUntil ?? publication.sync.retry?.connectionCooldownUntil
    }
  },
  updatedAt: input.now || new Date().toISOString()
}) as T;
