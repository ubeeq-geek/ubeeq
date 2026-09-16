import { randomUUID } from 'node:crypto';
import { canCommitVerifiedDirectMessagingLink, type DirectMessageInboxRecord, type DirectMessageOutboxRecord, type DirectMessagingAccountLink, type DirectMessagingLinkChallenge } from '@ubeeq/integrations';

type InboxClaim = DirectMessageInboxRecord & { claimToken?: string; claimExpiresAt?: string };
type Identity = { instanceId: string; receivingAccountId: string; senderId: string };
type Row = { payload: string; used_at?: string | null; revoked_at?: string | null; outbox_id: string };
type Database = { exec(sql: string): unknown; prepare(sql: string): {
  get(...args: unknown[]): Row | undefined; all(...args: unknown[]): Row[]; run(...args: unknown[]): { changes: number };
} };

/** Synchronous SQLite transactions; the host owns the database lifetime and volume. */
export class SqliteDirectMessagingStore {
  private readonly db: Database;
  constructor(database: unknown, readonly instanceId: string, readonly cellId: string) {
    if (!instanceId?.trim() || !cellId?.trim() || !database || typeof (database as Database).exec !== 'function' || typeof (database as Database).prepare !== 'function') throw new Error('SQLite messaging requires database, instance and cell.');
    const db = database as Database;
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS direct_messaging_inbox (instance_id TEXT NOT NULL, receiving_account_id TEXT NOT NULL, provider_message_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(instance_id, receiving_account_id, provider_message_id));
      CREATE TABLE IF NOT EXISTS direct_messaging_outbox (outbox_id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL, next_attempt_at TEXT);
      CREATE TABLE IF NOT EXISTS direct_messaging_challenges (challenge_id TEXT PRIMARY KEY, payload TEXT NOT NULL, used_at TEXT);
      CREATE TABLE IF NOT EXISTS direct_messaging_links (instance_id TEXT NOT NULL, receiving_account_id TEXT NOT NULL, sender_id TEXT NOT NULL, payload TEXT NOT NULL, revoked_at TEXT, PRIMARY KEY(instance_id, receiving_account_id, sender_id));`);
    db.exec("CREATE INDEX IF NOT EXISTS direct_messaging_outbox_inbox_key ON direct_messaging_outbox(json_extract(payload,'$.inboxKey.instanceId'),json_extract(payload,'$.inboxKey.receivingAccountId'),json_extract(payload,'$.inboxKey.providerMessageId'))");
  }
  private requireInstance(instanceId: string) { if (instanceId !== this.instanceId) throw new Error('Messaging instance mismatch.'); }
  async admitInbox(record: DirectMessageInboxRecord) {
    this.requireInstance(record.instanceId);
    const key = [record.instanceId, record.receivingAccountId, record.providerMessageId];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT payload FROM direct_messaging_inbox WHERE instance_id=? AND receiving_account_id=? AND provider_message_id=?').get(...key);
      const existing = row ? JSON.parse(row.payload) : undefined;
      if (existing && existing.senderId !== record.senderId) throw new Error('Inbox identity mismatch.');
      const completed = existing?.state === 'completed' || this.db.prepare("SELECT 1 FROM direct_messaging_outbox WHERE json_extract(payload,'$.inboxKey.instanceId')=? AND json_extract(payload,'$.inboxKey.receivingAccountId')=? AND json_extract(payload,'$.inboxKey.providerMessageId')=? LIMIT 1").get(...key);
      if (completed) { this.db.exec('COMMIT'); return { admitted: false, record: { ...(existing ?? record), state: 'completed' } }; }
      if (existing?.claimToken && Date.parse(existing.claimExpiresAt ?? '') > Date.now()) { this.db.exec('COMMIT'); return { admitted: false, record: existing }; }
      const claim: InboxClaim = { ...record, state: 'processing', claimToken: randomUUID(), claimExpiresAt: new Date(Date.now() + 120_000).toISOString() };
      this.db.prepare('INSERT OR REPLACE INTO direct_messaging_inbox VALUES (?,?,?,?)').run(...key, JSON.stringify(claim));
      this.db.exec('COMMIT'); return { admitted: true, record: claim };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async commitInboxReply(claim: InboxClaim, reply: DirectMessageOutboxRecord) {
    this.requireInstance(claim.instanceId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const key = [claim.instanceId, claim.receivingAccountId, claim.providerMessageId];
      const row = this.db.prepare('SELECT payload FROM direct_messaging_inbox WHERE instance_id=? AND receiving_account_id=? AND provider_message_id=?').get(...key);
      const current = row ? JSON.parse(row.payload) : undefined;
      if (!current || current.state !== 'processing' || !claim.claimToken || current.claimToken !== claim.claimToken ||
        !(Date.parse(current.claimExpiresAt ?? '') > Date.now()) || reply.to !== current.senderId ||
        reply.inboxKey.instanceId !== claim.instanceId || reply.inboxKey.receivingAccountId !== claim.receivingAccountId || reply.inboxKey.providerMessageId !== claim.providerMessageId)
        throw new Error('Inbox processing claim is no longer valid.');
      this.db.prepare('INSERT INTO direct_messaging_outbox(outbox_id,payload,state,next_attempt_at) VALUES (?,?,?,?)').run(reply.outboxId, JSON.stringify(reply), reply.state, reply.nextAttemptAt || null);
      this.db.prepare('UPDATE direct_messaging_inbox SET payload=? WHERE instance_id=? AND receiving_account_id=? AND provider_message_id=?')
        .run(JSON.stringify({ ...current, state: 'completed', claimToken: undefined, claimExpiresAt: undefined }), ...key);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async enqueueOutbox(record: DirectMessageOutboxRecord) { this.requireInstance(record.inboxKey.instanceId); this.db.prepare('INSERT OR REPLACE INTO direct_messaging_outbox(outbox_id,payload,state,next_attempt_at) VALUES (?,?,?,?)').run(record.outboxId, JSON.stringify(record), record.state, record.nextAttemptAt || null); }
  async claimOutbox(now: string): Promise<DirectMessageOutboxRecord | null> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const expired = this.db.prepare("SELECT outbox_id,payload FROM direct_messaging_outbox WHERE state='sending' AND json_extract(payload,'$.inboxKey.instanceId')=? AND (next_attempt_at IS NULL OR next_attempt_at<=?) LIMIT 100").all(this.instanceId, now);
      for (const row of expired) this.db.prepare("UPDATE direct_messaging_outbox SET payload=?,state='uncertain',next_attempt_at=NULL WHERE outbox_id=?")
        .run(JSON.stringify({ ...JSON.parse(row.payload), state: 'uncertain' }), row.outbox_id);
      const row = this.db.prepare("SELECT outbox_id,payload FROM direct_messaging_outbox WHERE json_extract(payload,'$.inboxKey.instanceId')=? AND (state='pending' OR (state='retry' AND (next_attempt_at IS NULL OR next_attempt_at<=?))) ORDER BY outbox_id LIMIT 1").get(this.instanceId, now);
      if (!row) { this.db.exec('COMMIT'); return null; }
      const previous = JSON.parse(row.payload);
      const item = { ...previous, state: 'sending', attemptCount: previous.attemptCount + 1, claimExpiresAt: new Date(Date.parse(now) + 120_000).toISOString() };
      this.db.prepare('UPDATE direct_messaging_outbox SET payload=?,state=?,next_attempt_at=? WHERE outbox_id=?').run(JSON.stringify(item), item.state, item.claimExpiresAt, row.outbox_id);
      this.db.exec('COMMIT');
      return item;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async completeOutbox(id: string, result: { state: 'sent' | 'retry' | 'uncertain' | 'failed'; nextAttemptAt?: string }) { const row = this.db.prepare('SELECT payload FROM direct_messaging_outbox WHERE outbox_id=?').get(id); if (!row || JSON.parse(row.payload).inboxKey.instanceId !== this.instanceId) return; this.db.prepare('UPDATE direct_messaging_outbox SET payload=?,state=?,next_attempt_at=? WHERE outbox_id=?').run(JSON.stringify({ ...JSON.parse(row.payload), ...result }), result.state, result.nextAttemptAt || null, id); }
  async save(challenge: DirectMessagingLinkChallenge) { this.requireInstance(challenge.instanceId); if (challenge.cellId !== this.cellId) throw new Error('Messaging cell mismatch.'); this.db.prepare('INSERT OR REPLACE INTO direct_messaging_challenges(challenge_id,payload,used_at) VALUES (?,?,?)').run(challenge.challengeId, JSON.stringify(challenge), challenge.usedAt || null); }
  async findChallenge(id: string): Promise<DirectMessagingLinkChallenge | null> {
    const row = this.db.prepare('SELECT payload,used_at FROM direct_messaging_challenges WHERE challenge_id=?').get(id);
    if (!row) return null;
    const record = JSON.parse(row.payload) as DirectMessagingLinkChallenge;
    return record.instanceId === this.instanceId && record.cellId === this.cellId ? { ...record, usedAt: row.used_at || undefined } : null;
  }
  async commitVerifiedLink(expected: DirectMessagingLinkChallenge, link: DirectMessagingAccountLink, now: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT payload,used_at FROM direct_messaging_challenges WHERE challenge_id=?').get(expected.challengeId);
      const current = row ? { ...JSON.parse(row.payload), usedAt: row.used_at || undefined } : null;
      if (expected.instanceId !== this.instanceId || expected.cellId !== this.cellId ||
        !canCommitVerifiedDirectMessagingLink(current, expected, link, now)) { this.db.exec('ROLLBACK'); return false; }
      this.db.prepare('UPDATE direct_messaging_challenges SET used_at=? WHERE challenge_id=?').run(now, expected.challengeId);
      this.db.prepare('INSERT OR REPLACE INTO direct_messaging_links(instance_id,receiving_account_id,sender_id,payload,revoked_at) VALUES (?,?,?,?,NULL)')
        .run(link.instanceId, link.receivingAccountId, link.senderId, JSON.stringify(link));
      this.db.exec('COMMIT');
      return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async consume(id: string, now: string) { const row = this.db.prepare('SELECT payload,used_at FROM direct_messaging_challenges WHERE challenge_id=?').get(id); if (!row || row.used_at) return null; const item = JSON.parse(row.payload); if (item.instanceId !== this.instanceId || item.cellId !== this.cellId) return null; if (Date.parse(item.expiresAt) <= Date.parse(now)) return null; const changed = this.db.prepare('UPDATE direct_messaging_challenges SET used_at=? WHERE challenge_id=? AND used_at IS NULL').run(now, id); return changed.changes === 1 ? item : null; }
  async create(link: DirectMessagingAccountLink) { this.requireInstance(link.instanceId); if (link.cellId !== this.cellId) throw new Error('Messaging cell mismatch.'); this.db.prepare('INSERT OR REPLACE INTO direct_messaging_links(instance_id,receiving_account_id,sender_id,payload,revoked_at) VALUES (?,?,?,?,?)').run(link.instanceId, link.receivingAccountId, link.senderId, JSON.stringify(link), link.revokedAt || null); }
  async resolve(input: Identity): Promise<DirectMessagingAccountLink | null> { if (input.instanceId !== this.instanceId) return null; const row = this.db.prepare('SELECT payload,revoked_at FROM direct_messaging_links WHERE instance_id=? AND receiving_account_id=? AND sender_id=?').get(input.instanceId, input.receivingAccountId, input.senderId); return row && !row.revoked_at ? JSON.parse(row.payload) : null; }
  async listVerified(input: { instanceId: string; actorId: string; creatorId: string }): Promise<DirectMessagingAccountLink[]> {
    if (input.instanceId !== this.instanceId) return [];
    return this.db.prepare("SELECT payload FROM direct_messaging_links WHERE instance_id=? AND revoked_at IS NULL AND json_extract(payload,'$.actorId')=? AND json_extract(payload,'$.creatorId')=? AND json_extract(payload,'$.verifiedAt') IS NOT NULL")
      .all(input.instanceId, input.actorId, input.creatorId).map(row => JSON.parse(row.payload));
  }
  async revoke(input: Identity & { actorId: string }) {
    if (input.instanceId !== this.instanceId) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT payload,revoked_at FROM direct_messaging_links WHERE instance_id=? AND receiving_account_id=? AND sender_id=?').get(input.instanceId, input.receivingAccountId, input.senderId);
      if (!row || row.revoked_at || JSON.parse(row.payload).actorId !== input.actorId) { this.db.exec('ROLLBACK'); return false; }
      const link = JSON.parse(row.payload);
      const now = new Date().toISOString();
      this.db.prepare('UPDATE direct_messaging_links SET revoked_at=? WHERE instance_id=? AND receiving_account_id=? AND sender_id=?').run(now, input.instanceId, input.receivingAccountId, input.senderId);
      this.db.prepare("UPDATE direct_messaging_challenges SET used_at=? WHERE used_at IS NULL AND json_extract(payload,'$.instanceId')=? AND json_extract(payload,'$.receivingAccountId')=? AND json_extract(payload,'$.actorId')=? AND json_extract(payload,'$.creatorId')=?")
        .run(now, link.instanceId, link.receivingAccountId, link.actorId, link.creatorId);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

