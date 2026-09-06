export type IntegrationTokenHealth = "valid" | "expires_soon" | "expired" | "unknown";
export type IntegrationConnectionState = "connected" | "authentication_required" | "rate_limited" | "temporarily_unavailable" | "disabled";

/** Credential-free projection input; adapters map their own durable records. */
export interface IntegrationHealthConnection<S extends string = IntegrationConnectionState> {
  connectionStatus: S;
  tokenExpiresAt?: string;
  grantedScopes?: readonly string[];
  rateLimitedUntil?: string;
  lastSuccessfulSyncAt?: string;
  lastSyncAttemptAt?: string;
  lastIssue?: { code: string; message: string; remediation: string; occurredAt?: string };
}

const timestamp = (value?: string): number | undefined => {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Measures token/cooldown health without selecting providers, capabilities,
 * retry actions or a product warning window. This is not token verification.
 */
export const projectIntegrationAccountHealth = <S extends string>(
  account: IntegrationHealthConnection<S>,
  options: { expiryWarningWindowMs: number; nowMs?: number }
) => {
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || !Number.isFinite(options.expiryWarningWindowMs) || options.expiryWarningWindowMs < 0) {
    throw new Error("Health projection requires a finite clock and non-negative warning window.");
  }
  const expiresAtMs = timestamp(account.tokenExpiresAt);
  const rateLimitedUntilMs = timestamp(account.rateLimitedUntil);
  const tokenStatus: IntegrationTokenHealth = expiresAtMs === undefined ? "unknown"
    : expiresAtMs <= nowMs ? "expired"
      : expiresAtMs - nowMs <= options.expiryWarningWindowMs ? "expires_soon" : "valid";
  const coolingDown = rateLimitedUntilMs !== undefined && rateLimitedUntilMs > nowMs;
  const state: S | "rate_limited" | "authentication_required" | "attention" | "connected" =
    account.connectionStatus !== "connected" ? account.connectionStatus
      : coolingDown ? "rate_limited"
        : tokenStatus === "expired" ? "authentication_required"
          : tokenStatus === "expires_soon" || account.lastIssue ? "attention" : "connected";
  return {
    state,
    token: { status: tokenStatus, expiresAt: account.tokenExpiresAt, grantedScopes: [...(account.grantedScopes || [])] },
    sync: {
      lastAttemptAt: account.lastSyncAttemptAt,
      lastSuccessfulAt: account.lastSuccessfulSyncAt,
      rateLimitedUntil: account.rateLimitedUntil,
      coolingDown
    },
    issue: account.lastIssue ? { ...account.lastIssue } : undefined
  };
};
