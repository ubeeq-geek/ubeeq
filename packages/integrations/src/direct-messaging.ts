/** Deterministic, channel-independent creator activity commands. No inference required. */
export type ActivityCommand = 'help' | 'activity' | 'comments' | 'favorites';
export function parseActivityCommand(text: string): ActivityCommand {
  const command = text.trim().toLowerCase().replace(/^\//, '');
  if (command === 'favourites') return 'favorites';
  return command === 'activity' || command === 'comments' || command === 'favorites' ? command : 'help';
}
export interface MessagingScope { instanceId: string; cellId: string; actorId: string; creatorId: string }
export interface MessagingIdentity { channel: 'whatsapp'; accountId: string; senderId: string }
export interface DirectMessage extends MessagingIdentity { messageId: string; text: string; sentAt?: string }
export interface ActivitySnapshot {
  /** Timestamp of the stored snapshot, not the time this query ran. */
  asOf: string;
  comments: readonly { source: string; workTitle: string; body: string }[];
  /** Null means unavailable; counts must never be presented as named favourite events. */
  favoriteCount: number | null;
}
export interface DirectMessagingPorts {
  /** Resolve an active dashboard-established link, scoped to this receiving account. */
  resolveLink(identity: MessagingIdentity): Promise<MessagingScope | null>;
  /** Recheck current creator membership and read permission for every request. */
  authorize(scope: MessagingScope): Promise<boolean>;
  /** Read a bounded, already synchronized view; exclude hidden/deleted comments. */
  readActivity(scope: MessagingScope, query: { command: Exclude<ActivityCommand, 'help'>; limit: number }): Promise<ActivitySnapshot>;
}
const help = 'Commands: activity, comments, favourites, help. Manage your linked creator in the dashboard.';
const compact = (value: string, max: number) => value.replace(/[\r\n\t]+/g, ' ').slice(0, max);
export async function handleDirectMessage(message: DirectMessage, ports: DirectMessagingPorts): Promise<string> {
  const command = parseActivityCommand(message.text);
  if (command === 'help') return help;
  const scope = await ports.resolveLink({ channel: message.channel, accountId: message.accountId, senderId: message.senderId });
  if (!scope || !await ports.authorize(scope)) return 'Link an authorized creator account in the dashboard to check activity.';
  const snapshot = await ports.readActivity(scope, { command, limit: 5 });
  if (!Number.isFinite(Date.parse(snapshot.asOf)) || (snapshot.favoriteCount !== null &&
      (!Number.isSafeInteger(snapshot.favoriteCount) || snapshot.favoriteCount < 0))) throw new Error('Invalid activity snapshot.');
  const lines = [`Activity as of ${new Date(snapshot.asOf).toISOString()}`];
  if (command !== 'comments') lines.push(snapshot.favoriteCount === null ? 'Favourite count unavailable.' : `Favourites (aggregate): ${snapshot.favoriteCount}`);
  if (command !== 'favorites') {
    const comments = snapshot.comments.slice(0, 5);
    lines.push(comments.length ? 'Recent comments (up to 5):' : 'No comments in this snapshot.');
    for (const comment of comments) lines.push(`[${compact(comment.source, 40)}] ${compact(comment.workTitle, 80)}: ${compact(comment.body, 350)}`);
  }
  lines.push('Open the dashboard for more details.');
  return lines.join('\n');
}
