import type { IntegrationOperation } from "./index.js";

/** Durable provider-independent progress; connector and product IDs remain opaque. */
export interface IntegrationSyncCheckpointContract {
  platform: string;
  connectionId: string;
  resourceType: string;
  resourceId: string;
  cursor?: string;
  highWatermarkAt?: string;
  recentRemoteIds: readonly string[];
  lastAttemptAt?: string;
  lastSuccessfulAt?: string;
  nextEligibleAt?: string;
}

export interface IntegrationSyncPage<T> {
  items: readonly T[];
  nextCursor?: string;
  complete: boolean;
}

export type IntegrationRecoveryDisposition = "retry" | "reauthorize" | "reconcile_before_retry" | "policy_blocked" | "terminal";
export type IntegrationFailureCode = "authentication_required" | "permission_denied" | "rate_limited" | "temporarily_unavailable" | "ambiguous_submission" | "invalid_request" | "policy_blocked" | "not_found" | "unknown";
export interface IntegrationRecoveryDecision {
  disposition: IntegrationRecoveryDisposition;
  retryAfterSeconds?: number;
  requiresRemoteLookup: boolean;
}

/** An ambiguous external write must be reconciled before it can be submitted again. */
export const integrationRecoveryDecision = (input: {
  operation: IntegrationOperation;
  code: IntegrationFailureCode;
  retryAfterSeconds?: number;
}): IntegrationRecoveryDecision => {
  if (input.code === "authentication_required") return { disposition: "reauthorize", requiresRemoteLookup: false };
  if (input.code === "policy_blocked" || input.code === "permission_denied") return { disposition: "policy_blocked", requiresRemoteLookup: false };
  if (input.code === "ambiguous_submission" && ["publish", "update_remote", "delete_remote"].includes(input.operation)) {
    return { disposition: "reconcile_before_retry", requiresRemoteLookup: true };
  }
  if (input.code === "rate_limited" || input.code === "temporarily_unavailable") {
    return { disposition: "retry", retryAfterSeconds: input.retryAfterSeconds, requiresRemoteLookup: false };
  }
  return { disposition: "terminal", requiresRemoteLookup: false };
};

export const advanceIntegrationCheckpoint = <T extends IntegrationSyncCheckpointContract>(
  checkpoint: T,
  page: IntegrationSyncPage<{ remoteId: string; occurredAt?: string }>,
  now = new Date().toISOString(),
  recentLimit = 200
): T & IntegrationSyncCheckpointContract => {
  if (!page.complete && !page.nextCursor) throw new Error("An incomplete sync page must provide a continuation cursor.");
  const remoteIds = page.items.map((item) => item.remoteId).filter(Boolean);
  const recentRemoteIds = [...new Set([...remoteIds, ...checkpoint.recentRemoteIds])].slice(0, Math.max(1, recentLimit));
  // Overlapping or out-of-order provider pages must not move the checkpoint backwards.
  const highWatermarkAt = [checkpoint.highWatermarkAt, ...page.items.map((item) => item.occurredAt)]
    .filter((value): value is string => Boolean(value)).sort().at(-1);
  return {
    ...checkpoint, cursor: page.nextCursor, highWatermarkAt, recentRemoteIds, lastAttemptAt: now,
    ...(page.complete ? { lastSuccessfulAt: now } : {})
  };
};
