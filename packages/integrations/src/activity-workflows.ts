import { randomUUID } from 'node:crypto';

export interface ActivityPrincipal { actorId: string; profileId: string }
export interface ActivitySelection { creators: string[]; platforms: string[] }
export interface ActivityEvent {
  id: string; creatorId: string; platform: string; sourceAt: string;
  kind: 'comment' | 'favorite_count' | 'health';
  commentId?: string; workId?: string;
  count?: number | null; previousCount?: number | null;
  health?: 'authorization_expiring' | 'authorization_expired' | 'publish_failed' | 'sync_stalled' | 'recovered';
  accountId?: string;
}
export interface StoredActivity extends ActivityEvent { sequence: number }
export interface ActivityDocument<T = unknown> { revision: number; value: T }
export interface ActivityWrite { key: string; revision: number | null; value: unknown }
/** Bound to one instance/cell. Conditional batch writes MUST be atomic. */
export interface ActivityWorkflowStore {
  get<T>(key: string): Promise<ActivityDocument<T> | null>;
  commit(writes: ActivityWrite[]): Promise<boolean>;
  scan(prefix: string, after: string, limit: number): Promise<{ key: string; document: ActivityDocument }[]>;
  append(event: ActivityEvent): Promise<void>;
  page(selection: ActivitySelection, after: number, limit: number, kind?: ActivityEvent['kind']): Promise<StoredActivity[]>;
}
export interface ActivityComment {
  id: string; creatorId: string; platform: string; body: string; workTitle: string;
  answered: boolean; replyAllowed: boolean;
  thread: { author: string; body: string }[];
}
export interface ActivityWorkflowPorts {
  /** Return currently authorized choices, bounded to 50 creators/platforms. */
  choices(actorId: string): Promise<{ creators: { id: string; name: string }[]; platforms: string[] }>;
  authorize(actorId: string, creatorId: string, operation: 'read' | 'reply'): Promise<boolean>;
  /** Resolve current visibility/holds; never return hidden or deleted content. */
  comment(actorId: string, event: ActivityEvent): Promise<ActivityComment | null>;
  visible(actorId: string, event: ActivityEvent): Promise<boolean>;
  /** Called after explicit confirmation. Never automatically retry an uncertain write. */
  reply(input: { actorId: string; event: ActivityEvent; body: string; idempotencyKey: string }): Promise<'sent' | 'not_sent' | 'unknown'>;
  /** Enforce channel opt-in, templates/windows, quotas and budgets before sending. */
  canNotify(principal: ActivityPrincipal): Promise<boolean>;
  notify(input: { principal: ActivityPrincipal; text: string; idempotencyKey: string }): Promise<'sent' | 'not_sent' | 'unknown'>;
}
export interface DigestPreferences {
  frequency: 'off' | 'hourly' | 'daily' | 'weekly';
  timeZone: string; quietStart: number; quietEnd: number; minEvents: number;
  healthAlerts: boolean;
}
interface Profile {
  selection: ActivitySelection; checkpoints: Record<string, number>;
  preferences: DigestPreferences; digestAfter: number; healthAfter: number; nextDigestAt: number;
}
interface PendingPage { selectionKey: string; through: number; expiresAt: number }
interface ReplyDraft { event: ActivityEvent; body: string; expiresAt: number; status: 'preview' | 'sending' | 'sent' | 'not_sent' | 'unknown' }
interface Notification { principal: ActivityPrincipal; events: StoredActivity[]; status: 'pending' | 'sending' | 'sent' | 'not_sent' | 'unknown'; kind: 'digest' | 'health'; expiresAt: number }
export class ActivityWorkflowError extends Error {
  constructor(readonly code: 'invalid' | 'denied' | 'conflict', message: string) { super(message); this.name = 'ActivityWorkflowError'; }
}
const fail = (code: ActivityWorkflowError['code'], message: string): never => { throw new ActivityWorkflowError(code, message); };
const identity = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 256;
const key = (...parts: string[]) => JSON.stringify(parts);
const selectionKey = (s: ActivitySelection) => JSON.stringify({ creators: [...s.creators].sort(), platforms: [...s.platforms].sort() });
const initial = (): Profile => ({ selection: { creators: [], platforms: [] }, checkpoints: {}, digestAfter: 0, healthAfter: 0, nextDigestAt: 0,
  preferences: { frequency: 'off', timeZone: 'UTC', quietStart: 22, quietEnd: 8, minEvents: 1, healthAlerts: false } });
const interval = { off: 0, hourly: 3600000, daily: 86400000, weekly: 604800000 };
const compact = (text: string, length: number) => text.replace(/[\r\n\t]+/g, ' ').slice(0, length);
export function validateActivityEvent(event: ActivityEvent): void {
  if (!event || ![event.id, event.creatorId, event.platform].every(identity) || !Number.isFinite(Date.parse(event.sourceAt)) ||
    !['comment', 'favorite_count', 'health'].includes(event.kind)) fail('invalid', 'Invalid activity event.');
  if (event.kind === 'comment' && !identity(event.commentId!)) fail('invalid', 'Comment reference required.');
  if (event.kind === 'favorite_count') for (const value of [event.count, event.previousCount]) {
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) fail('invalid', 'Invalid favourite count.');
  }
  if (event.kind === 'favorite_count' && event.count === undefined) fail('invalid', 'Favourite count or null required.');
  if (event.kind === 'health' && (!identity(event.accountId!) || !['authorization_expiring', 'authorization_expired', 'publish_failed', 'sync_stalled', 'recovered'].includes(event.health!))) fail('invalid', 'Invalid health event.');
}
export function inDigestQuietHours(preferences: DigestPreferences, now: number): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: preferences.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(now)));
  const { quietStart: start, quietEnd: end } = preferences;
  return start === end ? false : start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
export class ActivityWorkflows {
  constructor(readonly store: ActivityWorkflowStore, readonly ports: ActivityWorkflowPorts, private readonly clock = Date.now) {}
  private profileKey(p: ActivityPrincipal): string {
    if (!p || !identity(p.actorId) || !identity(p.profileId)) return fail('denied', 'Account link required.');
    return key('profile', p.actorId, p.profileId);
  }
  private resource(p: ActivityPrincipal, type: string, id: string) { return key(this.profileKey(p), type, id); }
  private async profile(p: ActivityPrincipal) { return await this.store.get<Profile>(this.profileKey(p)) ?? { revision: -1, value: initial() }; }
  private async change(p: ActivityPrincipal, operation: (profile: Profile) => void): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const record = await this.profile(p), value = structuredClone(record.value); operation(value);
      if (await this.store.commit([{ key: this.profileKey(p), revision: record.revision < 0 ? null : record.revision, value }])) return;
    }
    fail('conflict', 'Settings changed; retry.');
  }
  async choices(p: ActivityPrincipal) {
    this.profileKey(p); const choices = await this.ports.choices(p.actorId);
    if (choices.creators.length > 50 || choices.platforms.length > 50) return fail('invalid', 'Too many choices for this interface.');
    return choices;
  }
  private async admitted(p: ActivityPrincipal, selection: ActivitySelection): Promise<ActivitySelection> {
    const choices = await this.choices(p);
    const creators = selection.creators.length ? selection.creators : choices.creators.map(c => c.id);
    const platforms = selection.platforms.length ? selection.platforms : choices.platforms;
    for (const id of creators) if (!choices.creators.some(c => c.id === id) || !await this.ports.authorize(p.actorId, id, 'read')) return fail('denied', 'Creator access unavailable.');
    if (!creators.length || !platforms.length || platforms.some(id => !choices.platforms.includes(id))) return fail('denied', 'No authorized sources selected.');
    return { creators, platforms };
  }
  async selection(p: ActivityPrincipal) { return structuredClone((await this.profile(p)).value.selection); }
  async openComment(p: ActivityPrincipal, event: ActivityEvent) {
    this.profileKey(p); const comment = await this.currentComment(p, event);
    if (!comment) return fail('denied', 'Comment unavailable.');
    await this.mark(p, event, 'read'); return comment;
  }
  async select(p: ActivityPrincipal, selection: ActivitySelection): Promise<void> {
    if (!selection || !Array.isArray(selection.creators) || !Array.isArray(selection.platforms) ||
      selection.creators.length > 50 || selection.platforms.length > 50 || ![...selection.creators, ...selection.platforms].every(identity)) return fail('invalid', 'Invalid selection.');
    const normalized = { creators: [...new Set(selection.creators)].sort(), platforms: [...new Set(selection.platforms)].sort() };
    await this.admitted(p, normalized);
    await this.change(p, state => { state.selection = normalized; state.digestAfter = 0; state.healthAfter = 0; state.nextDigestAt = this.clock(); });
  }
  private async available(p: ActivityPrincipal, event: StoredActivity, selection: ActivitySelection): Promise<boolean> {
    return selection.creators.includes(event.creatorId) && selection.platforms.includes(event.platform) &&
      await this.ports.authorize(p.actorId, event.creatorId, 'read') && await this.ports.visible(p.actorId, event);
  }
  async activity(p: ActivityPrincipal): Promise<{ items: StoredActivity[]; acknowledge: string; more: boolean }> {
    const profile = (await this.profile(p)).value, selection = await this.admitted(p, profile.selection), scope = selectionKey(selection);
    const rows = await this.store.page(selection, profile.checkpoints[scope] ?? 0, 20);
    const items: StoredActivity[] = [];
    for (const event of rows) if (await this.available(p, event, selection)) items.push(event);
    const token = randomUUID();
    await this.store.commit([{ key: this.resource(p, 'page', token), revision: null, value: { selectionKey: scope, through: rows.at(-1)?.sequence ?? profile.checkpoints[scope] ?? 0, expiresAt: this.clock() + 900000 } satisfies PendingPage }]);
    return { items, acknowledge: token, more: rows.length === 20 };
  }
  async acknowledge(p: ActivityPrincipal, token: string) {
    const page = await this.store.get<PendingPage>(this.resource(p, 'page', token));
    if (!page || page.value.expiresAt < this.clock()) return fail('invalid', 'Activity page expired.');
    const scope = selectionKey(await this.admitted(p, (await this.profile(p)).value.selection));
    if (scope !== page.value.selectionKey) return fail('invalid', 'Selection changed; check activity again.');
    await this.change(p, state => {
      if (!Object.hasOwn(state.checkpoints, scope) && Object.keys(state.checkpoints).length >= 100) fail('invalid', 'Checkpoint selection limit reached.');
      state.checkpoints[scope] = Math.max(state.checkpoints[scope] ?? 0, page.value.through);
    });
  }
  async inbox(p: ActivityPrincipal, filter: 'all' | 'unread' | 'unanswered' | 'resolved' = 'all', after = 0) {
    if (!['all', 'unread', 'unanswered', 'resolved'].includes(filter) || !Number.isSafeInteger(after) || after < 0) return fail('invalid', 'Invalid inbox filter.');
    const selection = await this.admitted(p, (await this.profile(p)).value.selection);
    const rows = await this.store.page(selection, after, 20, 'comment'), items = [];
    for (const event of rows) {
      if (!await this.available(p, event, selection)) continue;
      const comment = await this.currentComment(p, event);
      if (!comment) continue;
      const state = (await this.store.get<{ read: boolean; resolved: boolean }>(this.resource(p, 'comment', key(event.creatorId, event.platform, event.commentId!))))?.value ?? { read: false, resolved: false };
      if ((filter === 'unread' && state.read) || (filter === 'unanswered' && (comment.answered || state.resolved)) || (filter === 'resolved' && !state.resolved)) continue;
      items.push({ event, comment, ...state });
    }
    return { items, next: rows.length === 20 ? rows.at(-1)!.sequence : null };
  }
  private async currentComment(p: ActivityPrincipal, event: ActivityEvent): Promise<ActivityComment | null> {
    if (event.kind !== 'comment' || !await this.ports.authorize(p.actorId, event.creatorId, 'read') || !await this.ports.visible(p.actorId, event)) return null;
    const comment = await this.ports.comment(p.actorId, event);
    return comment && comment.id === event.commentId && comment.creatorId === event.creatorId && comment.platform === event.platform ? comment : null;
  }
  async mark(p: ActivityPrincipal, event: ActivityEvent, action: 'read' | 'resolve' | 'reopen') {
    this.profileKey(p); if (!['read', 'resolve', 'reopen'].includes(action)) return fail('invalid', 'Invalid inbox action.');
    if (!await this.currentComment(p, event)) return fail('denied', 'Comment unavailable.');
    const id = this.resource(p, 'comment', key(event.creatorId, event.platform, event.commentId!));
    for (let attempt = 0; attempt < 5; attempt++) {
      const old = await this.store.get<{ read: boolean; resolved: boolean }>(id), value = old?.value ?? { read: false, resolved: false };
      if (action === 'read') value.read = true; else value.resolved = action === 'resolve';
      if (await this.store.commit([{ key: id, revision: old?.revision ?? null, value }])) return;
    }
    fail('conflict', 'Inbox changed; retry.');
  }
  async previewReply(p: ActivityPrincipal, event: ActivityEvent, body: string) {
    this.profileKey(p);
    if (typeof body !== 'string' || !body.trim() || body.length > 2000) return fail('invalid', 'Reply must contain 1–2000 characters.');
    const current = await this.currentComment(p, event);
    if (!current?.replyAllowed || !await this.ports.authorize(p.actorId, event.creatorId, 'reply')) return fail('denied', 'Reply unavailable.');
    const token = randomUUID(), draft: ReplyDraft = { event: structuredClone(event), body, expiresAt: this.clock() + 900000, status: 'preview' };
    await this.store.commit([{ key: this.resource(p, 'reply', token), revision: null, value: draft }]);
    return { token, body, target: { platform: event.platform, creatorId: event.creatorId, commentId: event.commentId, workTitle: current.workTitle } };
  }
  async confirmReply(p: ActivityPrincipal, token: string): Promise<string> {
    const id = this.resource(p, 'reply', token), record = await this.store.get<ReplyDraft>(id);
    if (!record) return fail('invalid', 'Reply preview unavailable.');
    const draft = record.value;
    if (draft.status !== 'preview') return draft.status; // A repeated confirmation cannot post twice.
    if (draft.expiresAt < this.clock()) return fail('invalid', 'Reply preview expired.');
    const current = await this.currentComment(p, draft.event);
    if (!current?.replyAllowed || !await this.ports.authorize(p.actorId, draft.event.creatorId, 'reply')) return fail('denied', 'Reply unavailable.');
    if (!await this.store.commit([{ key: id, revision: record.revision, value: { ...draft, status: 'sending' } }])) return 'already_processing';
    let status: 'sent' | 'not_sent' | 'unknown';
    try { status = await this.ports.reply({ actorId: p.actorId, event: draft.event, body: draft.body, idempotencyKey: id }); }
    catch { status = 'unknown'; }
    if (!['sent', 'not_sent', 'unknown'].includes(status)) status = 'unknown';
    await this.store.commit([{ key: id, revision: record.revision + 1, value: { ...draft, status } }]);
    return status;
  }
  async preferences(p: ActivityPrincipal, preferences?: DigestPreferences) {
    if (!preferences) return (await this.profile(p)).value.preferences;
    const value = structuredClone(preferences);
    if (typeof value.timeZone !== 'string' || !value.timeZone || !Object.hasOwn(interval, value.frequency) || !Number.isInteger(value.quietStart) || value.quietStart < 0 || value.quietStart > 23 ||
      !Number.isInteger(value.quietEnd) || value.quietEnd < 0 || value.quietEnd > 23 || !Number.isInteger(value.minEvents) || value.minEvents < 1 || value.minEvents > 20 || typeof value.healthAlerts !== 'boolean') return fail('invalid', 'Invalid digest settings.');
    try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(); } catch { return fail('invalid', 'Invalid time zone.'); }
    await this.admitted(p, (await this.profile(p)).value.selection);
    await this.change(p, state => { state.preferences = value; state.nextDigestAt = this.clock() + interval[value.frequency]; });
    return value;
  }
  /** Host scheduler supplies one linked principal at a time; no full-account scans. */
  async prepareNotification(p: ActivityPrincipal, kind: 'digest' | 'health'): Promise<string | null> {
    if (!['digest', 'health'].includes(kind)) return fail('invalid', 'Invalid notification kind.');
    const record = await this.profile(p), state = structuredClone(record.value), now = this.clock();
    if ((kind === 'digest' ? state.preferences.frequency === 'off' || now < state.nextDigestAt : !state.preferences.healthAlerts) || inDigestQuietHours(state.preferences, now)) return null;
    const selection = await this.admitted(p, state.selection), after = kind === 'digest' ? state.digestAfter : state.healthAfter;
    const rows: StoredActivity[] = [], events: StoredActivity[] = [];
    let cursor = after;
    // Bounded look-ahead avoids sending below threshold when a page contains
    // hidden/deleted events. Retain the checkpoint until enough visible events exist.
    for (let batch = 0; batch < 5 && events.length < 20; batch++) {
      const page = await this.store.page(selection, cursor, 20, kind === 'health' ? 'health' : undefined);
      if (!page.length) break;
      for (const event of page) {
        rows.push(event); cursor = event.sequence;
        if (await this.available(p, event, selection)) events.push(event);
        if (events.length === 20) break;
      }
      if (page.length < 20) break;
    }
    if (events.length < (kind === 'digest' ? state.preferences.minEvents : 1)) {
      // Entirely invisible batches may advance safely; visible events are never dropped.
      if (!events.length && rows.length) {
        if (kind === 'digest') state.digestAfter = cursor; else state.healthAfter = cursor;
        await this.store.commit([{ key: this.profileKey(p), revision: record.revision < 0 ? null : record.revision, value: state }]);
      }
      return null;
    }
    const token = randomUUID();
    if (kind === 'digest') { state.digestAfter = rows.at(-1)?.sequence ?? after; state.nextDigestAt = now + interval[state.preferences.frequency]; }
    else state.healthAfter = rows.at(-1)?.sequence ?? after;
    const writes: ActivityWrite[] = [{ key: this.profileKey(p), revision: record.revision < 0 ? null : record.revision, value: state }];
    if (events.length) writes.push({ key: this.resource(p, 'notification', token), revision: null, value: { principal: p, events, kind, status: 'pending', expiresAt: now + 86400000 } satisfies Notification });
    if (!await this.store.commit(writes)) return null;
    return events.length ? token : null;
  }
  /** Recover queued work after a scheduler/process restart. Sending records require
   * provider reconciliation; they must not be automatically sent again.
   */
  async notifications(p: ActivityPrincipal, after = '') {
    const prefix = JSON.stringify([this.profileKey(p), 'notification']).slice(0, -1) + ',';
    const rows = await this.store.scan(prefix, after, 50);
    return { items: rows.map(row => ({ token: JSON.parse(row.key)[2] as string, status: (row.document.value as Notification).status })),
      next: rows.length === 50 ? rows.at(-1)!.key : null };
  }
  async retryNotification(p: ActivityPrincipal, token: string): Promise<boolean> {
    const id = this.resource(p, 'notification', token), record = await this.store.get<Notification>(id);
    if (!record || record.value.status !== 'not_sent' || record.value.expiresAt < this.clock()) return false;
    return this.store.commit([{ key: id, revision: record.revision, value: { ...record.value, status: 'pending' } }]);
  }
  async deliverNotification(p: ActivityPrincipal, token: string): Promise<string> {
    const id = this.resource(p, 'notification', token), record = await this.store.get<Notification>(id);
    if (!record) return fail('invalid', 'Notification unavailable.');
    const notification = record.value;
    if (notification.status !== 'pending') return notification.status;
    const state = (await this.profile(p)).value, now = this.clock();
    if (notification.expiresAt < now || (notification.kind === 'digest' ? state.preferences.frequency === 'off' : !state.preferences.healthAlerts)) return 'disabled_or_expired';
    if (inDigestQuietHours(state.preferences, now) || !await this.ports.canNotify(p)) return 'deferred';
    const selection = await this.admitted(p, state.selection), events = [];
    for (const event of notification.events) if (await this.available(p, event, selection)) events.push(event);
    if (!events.length) return 'unavailable';
    const text = `${notification.kind === 'digest' ? 'Activity digest' : 'Integration health'}\n` + events.map(formatActivityEvent).join('\n');
    if (!await this.store.commit([{ key: id, revision: record.revision, value: { ...notification, status: 'sending' } }])) return 'already_processing';
    let status: 'sent' | 'not_sent' | 'unknown';
    try { status = await this.ports.notify({ principal: p, text: text.slice(0, 4000), idempotencyKey: id }); } catch { status = 'unknown'; }
    if (!['sent', 'not_sent', 'unknown'].includes(status)) status = 'unknown';
    await this.store.commit([{ key: id, revision: record.revision + 1, value: { ...notification, status } }]);
    return status;
  }
}
export function formatActivityEvent(event: ActivityEvent): string {
  const source = `[${compact(event.creatorId, 35)}/${compact(event.platform, 25)}]`;
  if (event.kind === 'comment') return `${source} New comment (${compact(event.commentId!, 50)}), source ${compact(event.sourceAt, 30)}`;
  if (event.kind === 'health') return `${source} ${event.health} (${compact(event.accountId!, 40)})`;
  if (event.count === null) return `${source} Favourite count unavailable.`;
  const delta = event.previousCount == null ? 'baseline unavailable' : `change ${event.count! - event.previousCount >= 0 ? '+' : ''}${event.count! - event.previousCount}`;
  return `${source} Favourites: ${event.count} (${delta}; aggregate), source ${compact(event.sourceAt, 30)}`;
}
