import { whatsAppTextReply } from './whatsapp.js';

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

export async function drainDirectMessagingOutbox(
  store: DirectMessagingInboxOutbox,
  now: string,
  send: (record: DirectMessageOutboxRecord) => Promise<WhatsAppTextSenderResult>
): Promise<DirectMessageOutboxRecord | null> {
  const record = await store.claimOutbox(now);
  if (!record) return null;
  try {
    await send(record);
    await store.completeOutbox(record.outboxId, { state: 'sent' });
  } catch (error) {
    const uncertain = error instanceof DOMException && error.name === 'AbortError';
    await store.completeOutbox(record.outboxId, { state: uncertain ? 'uncertain' : 'retry' });
  }
  return record;
}

/** Bounded, deadline-aware provider delivery. Hosts retain credentials and retry policy. */
export async function sendWhatsAppText(options: WhatsAppTextSenderOptions): Promise<WhatsAppTextSenderResult> {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10_000, 1_000), 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `https://graph.facebook.com/${encodeURIComponent(options.graphApiVersion)}/${encodeURIComponent(options.phoneNumberId)}/messages`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${options.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(whatsAppTextReply(options.recipient, options.body))
      }
    );
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > 64 * 1024) throw new Error('WhatsApp response exceeds the configured limit.');
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 64 * 1024) throw new Error('WhatsApp response exceeds the configured limit.');
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    if (!response.ok) throw new Error(`WhatsApp delivery failed (${response.status}).`);
    const payload = JSON.parse(text) as { messages?: Array<{ id?: string }> };
    const providerMessageId = payload.messages?.[0]?.id;
    if (typeof providerMessageId !== 'string' || providerMessageId.length === 0) throw new Error('WhatsApp response omitted message id.');
    return { providerMessageId };
  } finally {
    clearTimeout(timer);
  }
}
