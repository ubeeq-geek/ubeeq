import { randomUUID } from 'node:crypto';
import { ActivityWorkflows, ActivityWorkflowError, formatActivityEvent, type ActivityPrincipal, type ActivityEvent } from './activity-workflows.js';
import type { DirectMessage, MessagingIdentity } from './direct-messaging.js';
const help = `Commands:
activity | ack <page token>
creators [offset] | platforms [offset]
select creators <comma-separated IDs or all>
select platforms <comma-separated IDs or all>
inbox [all|unread|unanswered|resolved] [cursor]
thread <reference> | resolve <reference> | reopen <reference>
reply <reference> <your text> | confirm <preview token>
digest [off|hourly|daily|weekly]
zone <IANA time zone> | quiet <start hour>-<end hour>
minimum <event count> | alerts on|off
No automatic replies. Use exact IDs shown in choices.`;
const referenceKey = (p: ActivityPrincipal, id: string) => JSON.stringify(['activity-command', p.actorId, p.profileId, id]);
const clean = (text: string, max: number) => text.replace(/[\r\n\t]+/g, ' ').slice(0, max);
export class ActivityCommandInterface {
  constructor(readonly workflows: ActivityWorkflows, private readonly now = Date.now) {}
  private async reference(p: ActivityPrincipal, id: string): Promise<ActivityEvent> {
    const saved = await this.workflows.store.get<{ event: ActivityEvent; expiresAt: number }>(referenceKey(p, id));
    if (!saved || saved.value.expiresAt < this.now()) throw new ActivityWorkflowError('invalid', 'Comment reference expired; open the inbox again.');
    return saved.value.event;
  }
  async execute(p: ActivityPrincipal, input: string): Promise<string> {
    if (typeof input !== 'string' || input.length > 4096) return 'Command too long.';
    // Validate linked principal even for help and profile-local resource lookups.
    if (!p || !p.actorId?.trim() || !p.profileId?.trim()) return 'Link your account first.';
    const text = input.trim().replace(/^\//, ''), [rawCommand, ...args] = text.split(/\s+/), command = rawCommand.toLowerCase();
    try {
      if (command === 'creators' || command === 'platforms') {
        const choices = await this.workflows.choices(p), offset = args.length ? Number(args[0]) : 0;
        if (args.length > 1 || !Number.isInteger(offset) || offset < 0 || offset > 50) return 'Invalid choices offset.';
        const rows = command === 'creators' ? choices.creators.map(c => `${clean(c.id, 256)}: ${clean(c.name, 80)}`) : choices.platforms;
        return (rows.slice(offset, offset + 10).join('\n') || 'No authorized choices.') + (rows.length > offset + 10 ? `\nNext: ${command} ${offset + 10}` : '');
      }
      if (command === 'select' && ['creators', 'platforms'].includes(args[0]) && args.length === 2) {
        const selection = await this.workflows.selection(p), ids = args[1] === 'all' ? [] : args[1].split(',');
        if (args[0] === 'creators') selection.creators = ids; else selection.platforms = ids;
        await this.workflows.select(p, selection); return 'Selection saved.';
      }
      if (command === 'activity' && !args.length) {
        const page = await this.workflows.activity(p);
        return `${page.items.map(formatActivityEvent).join('\n') || 'No new activity.'}\nSave checkpoint: ack ${page.acknowledge}${page.more ? '\nThen use activity for the next page.' : ''}`.slice(0, 4000);
      }
      if (command === 'ack' && args.length === 1) { await this.workflows.acknowledge(p, args[0]); return 'Activity checkpoint saved.'; }
      if (command === 'inbox' && args.length <= 2) {
        const page = await this.workflows.inbox(p, (args[0] ?? 'all') as 'all', args[1] === undefined ? 0 : Number(args[1]));
        const lines = [];
        for (const item of page.items) {
          const ref = randomUUID();
          await this.workflows.store.commit([{ key: referenceKey(p, ref), revision: null, value: { event: item.event, expiresAt: this.now() + 900000 } }]);
          lines.push(`${ref} [${clean(item.event.platform, 25)}] ${item.read ? 'read' : 'unread'}, ${item.resolved ? 'resolved' : item.comment.answered ? 'answered' : 'unanswered'}: ${clean(item.comment.body, 90)}`);
        }
        return `${lines.join('\n') || 'No matching comments in this page.'}${page.next !== null ? `\nNext: inbox ${args[0] ?? 'all'} ${page.next}` : ''}`;
      }
      if (['thread', 'resolve', 'reopen'].includes(command) && args.length === 1) {
        const event = await this.reference(p, args[0]);
        if (command === 'thread') {
          const comment = await this.workflows.openComment(p, event);
          return `${clean(comment.workTitle, 100)}\n${clean(comment.body, 1200)}\n${comment.thread.slice(-5).map(item => `${clean(item.author, 40)}: ${clean(item.body, 350)}`).join('\n')}`;
        }
        await this.workflows.mark(p, event, command as 'resolve' | 'reopen'); return 'Inbox status saved.';
      }
      if (command === 'reply' && args.length >= 2) {
        const body = text.replace(/^\S+\s+\S+\s+/, '');
        const preview = await this.workflows.previewReply(p, await this.reference(p, args[0]), body);
        return `Reply preview — ${clean(preview.target.creatorId, 50)}/${clean(preview.target.platform, 30)}: ${clean(preview.target.workTitle, 100)}\n${preview.body}\nSend exactly this reply: confirm ${preview.token}`;
      }
      if (command === 'confirm' && args.length === 1) return `Reply status: ${await this.workflows.confirmReply(p, args[0])}.`;
      if (['digest', 'zone', 'quiet', 'minimum', 'alerts'].includes(command)) {
        const preferences = await this.workflows.preferences(p);
        if (command === 'digest' && !args.length) return JSON.stringify(preferences);
        if (args.length !== 1) return help;
        if (command === 'digest') preferences.frequency = args[0] as typeof preferences.frequency;
        if (command === 'zone') preferences.timeZone = args[0];
        if (command === 'quiet') {
          if (!/^\d{1,2}-\d{1,2}$/.test(args[0])) return 'Use quiet 22-8 (equal hours disable quiet hours).';
          [preferences.quietStart, preferences.quietEnd] = args[0].split('-').map(Number);
        }
        if (command === 'minimum') preferences.minEvents = Number(args[0]);
        if (command === 'alerts') { if (!['on', 'off'].includes(args[0])) return 'Use alerts on or alerts off.'; preferences.healthAlerts = args[0] === 'on'; }
        await this.workflows.preferences(p, preferences); return 'Notification preferences saved.';
      }
      return help;
    } catch (error) {
      if (error instanceof ActivityWorkflowError) return error.message;
      // Do not leak provider, credential or database error details into messaging.
      return 'Unable to complete this request. Try again later.';
    }
  }
}
/** Resolve active dashboard-established links using the full receiving account identity.
 * Host inbox admission/deduplication and rate limits run before this adapter.
 */
export async function handleActivityWorkflowMessage(message: DirectMessage, commands: ActivityCommandInterface,
  resolve: (identity: MessagingIdentity) => Promise<ActivityPrincipal | null>): Promise<string> {
  const principal = await resolve({ channel: message.channel, accountId: message.accountId, senderId: message.senderId });
  return principal ? commands.execute(principal, message.text) : 'Link your creator account in the dashboard first.';
}
