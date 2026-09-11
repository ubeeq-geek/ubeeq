/** Common connector failure vocabulary; adapters retain provider-specific mapping. */
export class ExternalProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'authentication_required' | 'rate_limited' | 'temporarily_unavailable' | 'ambiguous_submission' | 'invalid_response' | 'unsupported' | 'preflight_blocked',
    readonly retryAfterSeconds?: number,
    readonly operation?: 'token_exchange' | 'account_lookup'
  ) {
    super(message);
    this.name = 'ExternalProviderError';
  }
}

/** Compatibility parser for existing connector delay hints. This is not a retry
 * scheduler or permission to replay a remote write. The caller owns delay caps,
 * durable scheduling and ambiguous-submission reconciliation.
 */
export const parseRetryAfterSeconds = (value: string | null | undefined, now = Date.now()): number | undefined => {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
};
