import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DirectMessage } from './direct-messaging.js';

/** The HTTP adapter must cap the body while reading, before allocating this buffer. */
export function verifyWhatsAppSignature(rawBody: Uint8Array, signature: string | undefined, appSecret: string): boolean {
  if (!appSecret || rawBody.byteLength > 256 * 1024 || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}
export function verifyWhatsAppChallenge(query: URLSearchParams, verifyToken: string): string | null {
  const supplied = query.get('hub.verify_token') ?? '';
  const expected = Buffer.from(verifyToken), actual = Buffer.from(supplied);
  if (!verifyToken || query.get('hub.mode') !== 'subscribe' || expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const challenge = query.get('hub.challenge');
  return challenge && /^\d{1,128}$/.test(challenge) ? challenge : null;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._+=:/-]{1,256}$/.test(value);
/** Verifies the original bytes before parsing. Rejects foreign receiving accounts. */
export function decodeWhatsAppWebhook(input: { rawBody: Uint8Array; signature?: string; appSecret: string; phoneNumberId: string }): DirectMessage[] {
  if (!verifyWhatsAppSignature(input.rawBody, input.signature, input.appSecret)) throw new Error('Invalid WhatsApp signature.');
  const payload = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.rawBody)));
  if (payload.object !== 'whatsapp_business_account') return [];
  const messages: DirectMessage[] = [];
  const seen = new Set<string>();
  for (const entry of array(payload.entry)) for (const change of array(object(entry).changes)) {
    if (object(change).field !== 'messages') continue;
    const value = object(object(change).value);
    if (object(value.metadata).phone_number_id !== input.phoneNumberId) continue;
    for (const item of array(value.messages)) {
      const message = object(item);
      if (!id(message.id) || typeof message.from !== 'string' || !/^\d{1,20}$/.test(message.from) || seen.has(message.id)) continue;
      const interactive = object(message.interactive);
      const text = message.type === 'text' ? object(message.text).body : message.type === 'interactive' ?
        object(interactive.type === 'button_reply' ? interactive.button_reply : interactive.type === 'list_reply' ? interactive.list_reply : null).id : undefined;
      if (typeof text !== 'string' || !text.trim() || text.length > 4096) continue;
      seen.add(message.id);
      const timestamp = typeof message.timestamp === 'string' && /^\d{1,12}$/.test(message.timestamp) ? Number(message.timestamp) * 1000 : NaN;
      messages.push({ channel: 'whatsapp', accountId: input.phoneNumberId, senderId: message.from, messageId: message.id, text,
        ...(Number.isFinite(timestamp) ? { sentAt: new Date(timestamp).toISOString() } : {}) });
    }
  }
  return messages;
}
/** Payload for a reply to an admitted inbound request; the host owns delivery/window policy. */
export function whatsAppTextReply(to: string, body: string) {
  if (!/^\d{1,20}$/.test(to) || !body.trim() || body.length > 4096) throw new Error('Invalid WhatsApp reply.');
  return { messaging_product: 'whatsapp' as const, recipient_type: 'individual' as const, to, type: 'text' as const, text: { preview_url: false, body } };
}
