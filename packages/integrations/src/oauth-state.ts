import { createHash, createHmac, randomUUID } from 'node:crypto';

/** The product supplies a signer/verifier with its own algorithm, keys and expiry policy. */
export interface OAuthStateCodec {
  sign(payload: Record<string, unknown>): string;
  verify(value: string): unknown;
}

/** No credential belongs in state. Nonce replay consumption remains a durable caller operation. */
export const issueOAuthState = <T extends object>(value: T, codec: Pick<OAuthStateCodec, 'sign'>): { state: string; nonce: string } => {
  const nonce = randomUUID();
  return { state: codec.sign({ ...value, nonce }), nonce };
};

/** Verify the envelope; provider-specific claim validation remains mandatory in the caller. */
export const verifyOAuthState = (value: string, codec: Pick<OAuthStateCodec, 'verify'>): Record<string, unknown> => {
  const payload = codec.verify(value);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('OAuth state is invalid');
  }
  return payload as Record<string, unknown>;
};

/** Deterministic compatibility PKCE: retain the caller's existing domain separator and key. */
export const deriveOAuthPkce = (secret: string, nonce: string, domainSeparator: string) => {
  const codeVerifier = createHmac('sha256', secret).update(`${domainSeparator}${nonce}`).digest('base64url');
  return { codeVerifier, codeChallenge: createHash('sha256').update(codeVerifier, 'utf8').digest('base64url') };
};
