import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type DirectMessagingLinkChallenge = {
  challengeId: string;
  instanceId: string;
  receivingAccountId: string;
  cellId: string;
  actorId: string;
  creatorId: string;
  digest: string;
  expiresAt: string;
  usedAt?: string;
};

export interface DirectMessagingLinkStore {
  save(challenge: DirectMessagingLinkChallenge): Promise<void>;
  consume(challengeId: string, now: string): Promise<DirectMessagingLinkChallenge | null>;
}

export type DirectMessagingAccountLink = {
  instanceId: string;
  receivingAccountId: string;
  senderId: string;
  actorId: string;
  creatorId: string;
  cellId: string;
  createdAt: string;
  revokedAt?: string;
};

export interface DirectMessagingAccountLinkStore {
  create(link: DirectMessagingAccountLink): Promise<void>;
  resolve(input: { instanceId: string; receivingAccountId: string; senderId: string }): Promise<DirectMessagingAccountLink | null>;
  revoke(input: { instanceId: string; receivingAccountId: string; senderId: string; actorId: string }): Promise<boolean>;
}

export const issueDirectMessagingLinkChallenge = async (
  store: DirectMessagingLinkStore,
  input: Omit<DirectMessagingLinkChallenge, 'challengeId' | 'digest' | 'expiresAt' | 'usedAt'>,
  ttlMs = 10 * 60_000
): Promise<{ challengeId: string; token: string; expiresAt: string }> => {
  if (!Number.isInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 15 * 60_000) throw new Error('Invalid link challenge lifetime.');
  const token = randomBytes(32).toString('base64url');
  const challengeId = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await store.save({ ...input, challengeId, digest: createHash('sha256').update(token).digest('hex'), expiresAt });
  return { challengeId, token, expiresAt };
};

export const consumeDirectMessagingLinkChallenge = async (
  store: DirectMessagingLinkStore,
  challengeId: string,
  token: string,
  now = new Date().toISOString()
): Promise<DirectMessagingLinkChallenge | null> => {
  if (!/^[a-f0-9]{32}$/.test(challengeId) || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const challenge = await store.consume(challengeId, now);
  if (!challenge || challenge.usedAt || Date.parse(challenge.expiresAt) <= Date.parse(now)) return null;
  const expected = Buffer.from(challenge.digest, 'hex');
  const actual = createHash('sha256').update(token).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? challenge : null;
};
