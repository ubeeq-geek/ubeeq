import { createHash } from 'node:crypto';

export interface OAuthNonceClaim { key: string; expiresAt: number; now: number }
export interface OAuthNonceClaimStore {
  /** Atomic insert-if-absent. Never replace a live claim. Times are epoch seconds. */
  claimOAuthNonce(input: OAuthNonceClaim): Promise<boolean>;
}
export class OAuthStateClaimError extends Error {
  constructor(public readonly code: 'invalid_state' | 'already_used') {
    super(code === 'invalid_state' ? 'OAuth state is invalid or expired.' : 'OAuth state has already been used.');
    this.name = 'OAuthStateClaimError';
  }
}

/** Call only after signature and actor/provider claim validation, before external side effects. */
export const claimVerifiedOAuthState = async (input: {
  namespace: string; nonce: string; expiresAt: number; now?: number;
}, store: OAuthNonceClaimStore): Promise<void> => {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (typeof input.namespace !== 'string' || !input.namespace.trim() || typeof input.nonce !== 'string' || !input.nonce.trim() ||
    !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
    throw new OAuthStateClaimError('invalid_state');
  }
  const key = createHash('sha256').update(JSON.stringify([input.namespace, input.nonce])).digest('hex');
  if (!await store.claimOAuthNonce({ key, expiresAt: input.expiresAt, now })) throw new OAuthStateClaimError('already_used');
};
