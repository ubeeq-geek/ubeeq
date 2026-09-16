import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DirectMessage, MessagingScope } from './direct-messaging.js';

export interface VerifiedDirectMessagingLinkStore {
  findChallenge(challengeId: string): Promise<DirectMessagingLinkChallenge | null>;
  /** Atomically compare the unused challenge, consume it and save the link.
   * Return false on replay or a changed challenge; roll back both writes on failure. */
  commitVerifiedLink(challenge: DirectMessagingLinkChallenge, link: DirectMessagingAccountLink, now: string): Promise<boolean>;
}

/** Use inside the adapter's transaction, against its current persisted record. */
export const canCommitVerifiedDirectMessagingLink = (
  current: DirectMessagingLinkChallenge | null,
  expected: DirectMessagingLinkChallenge,
  link: DirectMessagingAccountLink,
  now: string
): boolean => Boolean(current && !current.usedAt && Number.isFinite(Date.parse(now)) &&
  Date.parse(current.expiresAt) > Date.parse(now) &&
  (['challengeId', 'digest', 'expiresAt', 'instanceId', 'receivingAccountId', 'cellId', 'actorId', 'creatorId'] as const)
    .every(key => current[key] === expected[key]) &&
  (['instanceId', 'receivingAccountId', 'cellId', 'actorId', 'creatorId'] as const)
    .every(key => current[key] === link[key]) && /^\d{1,20}$/.test(link.senderId) && !link.revokedAt && link.createdAt === now && link.verifiedAt === now);

/** Call only for messages returned by the signature-verifying webhook decoder.
 * Sender/account identity comes from that event, never from a dashboard body. */
export const handleVerifiedDirectMessagingLinkCommand = async (
  message: DirectMessage,
  instanceId: string,
  store: VerifiedDirectMessagingLinkStore,
  authorize: (scope: MessagingScope) => Promise<boolean>,
  now = new Date().toISOString()
): Promise<string | null> => {
  if (!/^\/?link(?:\s|$)/i.test(message.text.trim())) return null;
  const match = /^\/?link ([a-f0-9]{32}) ([A-Za-z0-9_-]{43})$/.exec(message.text.trim());
  const rejected = 'Link not completed. Create a new link challenge in the dashboard and send its command here.';
  if (!match || !/^\d{1,20}$/.test(message.senderId)) return rejected;
  const challenge = await store.findChallenge(match[1]);
  if (!challenge || challenge.usedAt || challenge.instanceId !== instanceId ||
    challenge.receivingAccountId !== message.accountId || !Number.isFinite(Date.parse(now)) ||
    !(Date.parse(challenge.expiresAt) > Date.parse(now))) return rejected;
  const expected = Buffer.from(challenge.digest, 'hex');
  const supplied = createHash('sha256').update(match[2]).digest();
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return rejected;
  const scope = { instanceId, cellId: challenge.cellId, actorId: challenge.actorId, creatorId: challenge.creatorId };
  if (!await authorize(scope)) return rejected;
  const link = { ...scope, receivingAccountId: message.accountId, senderId: message.senderId, createdAt: now, verifiedAt: now };
  return await store.commitVerifiedLink(challenge, link, now)
    ? 'Creator linked. You can now request activity, comments or favourites.' : rejected;
};

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
  /** Set only by atomic redemption of a challenge from a verified provider event. */
  verifiedAt?: string;
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
