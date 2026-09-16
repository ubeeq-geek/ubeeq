import { handleDirectMessage, type DirectMessage, type DirectMessagingPorts } from './direct-messaging.js';
import { handleVerifiedDirectMessagingLinkCommand, type VerifiedDirectMessagingLinkStore } from './direct-messaging-link.js';
import { drainDirectMessagingOutbox, sendWhatsAppText, type DirectMessagingInboxOutbox, type DirectMessageOutboxRecord, type WhatsAppTextSenderOptions } from './direct-messaging-transport.js';

/** Product policy: only fresh on-demand replies, never proactive delivery. */
export async function prepareDirectMessagingReply(message: DirectMessage, instanceId: string, ports: DirectMessagingPorts,
  linkStore?: VerifiedDirectMessagingLinkStore, now = new Date().toISOString()) {
  const linkReply = linkStore ? await handleVerifiedDirectMessagingLinkCommand(message, instanceId, linkStore, scope => ports.authorize(scope)) : null;
  const scope = await ports.resolveLink(message);
  const authorized = scope && scope.instanceId === instanceId && await ports.authorize(scope) ? scope : null;
  const body = linkReply ?? await handleDirectMessage(message, { resolveLink: async () => authorized,
    authorize: scope => ports.authorize(scope), readActivity: (scope, query) => ports.readActivity(scope, query) });
  const timestamp = Date.parse(message.sentAt ?? '');
  const clock = Date.parse(now);
  const expiresAt = Number.isFinite(timestamp) && timestamp <= clock + 60_000
    ? new Date(Math.min(timestamp, clock) + 15 * 60_000).toISOString() : now;
  const deliveryContext: NonNullable<DirectMessageOutboxRecord['deliveryContext']> = {
    expiresAt, ...(authorized ? { scope: authorized } : { publicReply: true as const })
  };
  return { body, deliveryContext };
}

export function createDirectMessagingDeliveryWorker(input: {
  instanceId: string;
  store: DirectMessagingInboxOutbox;
  ports: DirectMessagingPorts;
  sender: Omit<WhatsAppTextSenderOptions, 'recipient' | 'body'>;
  clock?: () => string;
}) {
  let running = false;
  return {
    /** At most one provider call per tick, with no overlapping ticks in this worker. */
    async tick(): Promise<boolean> {
      if (running) return false;
      running = true;
      const clock = input.clock ?? (() => new Date().toISOString());
      try {
        const result = await drainDirectMessagingOutbox(input.store, clock(), record => sendWhatsAppText({ ...input.sender, recipient: record.to, body: record.body }), async record => {
          const context = record.deliveryContext;
          if (record.inboxKey.instanceId !== input.instanceId || record.inboxKey.receivingAccountId !== input.sender.phoneNumberId ||
            !context || !(Date.parse(context.expiresAt) > Date.parse(clock()))) return false;
          if (context.publicReply && !context.scope) return true;
          if (!context.scope) return false;
          const current = await input.ports.resolveLink({ channel: 'whatsapp', accountId: record.inboxKey.receivingAccountId, senderId: record.to });
          if (!current || !(['instanceId', 'cellId', 'actorId', 'creatorId'] as const).every(key => current[key] === context.scope![key])) return false;
          return await input.ports.authorize(current) && Date.parse(context.expiresAt) > Date.parse(clock());
        });
        return result !== null;
      } finally { running = false; }
    }
  };
}
