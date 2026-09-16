import { whatsAppTextReply } from './whatsapp.js';
import type { MessagingScope } from './direct-messaging.js';

export type DirectMessageInboxKey = {
  instanceId: string;
  receivingAccountId: string;
  providerMessageId: string;
};

export type DirectMessageInboxRecord = DirectMessageInboxKey & {
  senderId: string;
  receivedAt: string;
  state: 'admitted' | 'processing' | 'completed' | 'failed';
};

export type DirectMessageOutboxRecord = {
  outboxId: string;
  inboxKey: DirectMessageInboxKey;
  to: string;
  body: string;
  state: 'pending' | 'sending' | 'sent' | 'retry' | 'uncertain' | 'failed';
  attemptCount: number;
  nextAttemptAt?: string;
  claimExpiresAt?: string;
  deliveryContext?: { expiresAt: string; scope?: MessagingScope; publicReply?: true };
};

/** Host-owned durable boundary; implementations must make inbox admission idempotent. */
export interface DirectMessagingInboxOutbox {
  admitInbox(record: DirectMessageInboxRecord): Promise<{ admitted: boolean; record: DirectMessageInboxRecord }>;
  enqueueOutbox(record: DirectMessageOutboxRecord): Promise<void>;
  claimOutbox(now: string): Promise<DirectMessageOutboxRecord | null>;
  completeOutbox(outboxId: string, result: { state: 'sent' | 'retry' | 'uncertain' | 'failed'; nextAttemptAt?: string }): Promise<void>;
}

export type WhatsAppTextSenderOptions = {
  accessToken: string;
  phoneNumberId: string;
  graphApiVersion: string;
  recipient: string;
  body: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type WhatsAppTextSenderResult = { providerMessageId: string };

export class DirectMessagingDeliveryError extends Error {
  constructor(readonly outcome: 'retry' | 'uncertain' | 'failed', readonly retryAfterMs?: number) {
    super(`Messaging delivery ${outcome}.`);
  }
}

export async function drainDirectMessagingOutbox(
  store: DirectMessagingInboxOutbox,
  now: string,
  send: (record: DirectMessageOutboxRecord) => Promise<WhatsAppTextSenderResult>,
  authorizeDelivery?: (record: DirectMessageOutboxRecord) => Promise<boolean>
): Promise<DirectMessageOutboxRecord | null> {
  if (!Number.isFinite(Date.parse(now))) throw new Error('Invalid delivery clock.');
  const record = await store.claimOutbox(now);
  if (!record) return null;
  let result: { state: 'sent' | 'retry' | 'uncertain' | 'failed'; nextAttemptAt?: string };
  try {
    if (!authorizeDelivery || !await authorizeDelivery(record)) {
      result = { state: 'failed' };
    } else {
      await send(record);
      result = { state: 'sent' };
    }
  } catch (error) {
    const outcome = error instanceof DirectMessagingDeliveryError ? error.outcome : 'uncertain';
    const retryAfter = error instanceof DirectMessagingDeliveryError ? error.retryAfterMs ?? 0 : 0;
    if (outcome === 'retry' && record.attemptCount < 5 && Number.isFinite(retryAfter) && retryAfter <= 24 * 60 * 60_000) {
      const delay = Math.max(Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, record.attemptCount - 1)), retryAfter);
      result = { state: 'retry', nextAttemptAt: new Date(Date.parse(now) + delay).toISOString() };
    } else result = { state: outcome === 'retry' ? 'failed' : outcome };
  }
  // A storage failure after a successful send must never become an automatic retry.
  await store.completeOutbox(record.outboxId, result);
  return record;
}

/** Bounded, deadline-aware provider delivery. Hosts retain credentials and retry policy. */
export async function sendWhatsAppText(options: WhatsAppTextSenderOptions): Promise<WhatsAppTextSenderResult> {
  if (!options.accessToken.trim() || !/^v[0-9]+\.[0-9]+$/.test(options.graphApiVersion) ||
    !/^\d{1,20}$/.test(options.phoneNumberId) || (options.timeoutMs !== undefined && !Number.isFinite(options.timeoutMs))) {
    throw new DirectMessagingDeliveryError('failed');
  }
  let reply;
  try { reply = whatsAppTextReply(options.recipient, options.body); }
  catch { throw new DirectMessagingDeliveryError('failed'); }
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10_000, 1_000), 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `https://graph.facebook.com/${encodeURIComponent(options.graphApiVersion)}/${encodeURIComponent(options.phoneNumberId)}/messages`,
      {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${options.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(reply)
      }
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const retrySeconds = Number(response.headers.get('retry-after'));
      if (response.status === 429) throw new DirectMessagingDeliveryError('retry', Number.isFinite(retrySeconds) ? Math.max(0, retrySeconds) * 1000 : undefined);
      throw new DirectMessagingDeliveryError(response.status >= 500 || response.status === 408 ? 'uncertain' : 'failed');
    }
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > 64 * 1024) { await response.body?.cancel().catch(() => undefined); throw new DirectMessagingDeliveryError('uncertain'); }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 64 * 1024) { await reader.cancel().catch(() => undefined); throw new DirectMessagingDeliveryError('uncertain'); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    const payload = JSON.parse(text) as { messages?: Array<{ id?: string }> };
    const providerMessageId = payload.messages?.[0]?.id;
    if (typeof providerMessageId !== 'string' || providerMessageId.length === 0) throw new Error('WhatsApp response omitted message id.');
    return { providerMessageId };
  } catch (error) {
    if (error instanceof DirectMessagingDeliveryError) throw error;
    throw new DirectMessagingDeliveryError('uncertain');
  } finally {
    clearTimeout(timer);
  }
}
