import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDirectMessagingDeliveryWorker } from './direct-messaging-delivery.js';
import type { DirectMessagingPorts } from './direct-messaging.js';
import type { DirectMessagingInboxOutbox, DirectMessageInboxRecord, DirectMessageOutboxRecord } from './direct-messaging-transport.js';

export interface PersistentMessagingWorkerConfiguration {
  dataDirectory?: string;
  instanceId: string;
  cellId?: string;
  ports: DirectMessagingPorts;
  store?: DirectMessagingInboxOutbox;
  whatsapp: {
    appSecret?: string;
    verifyToken?: string;
    phoneNumberId?: string;
    accessToken?: string;
    graphApiVersion?: string;
  };
  tickIntervalMs?: number;
}

class InternalSqliteDirectMessagingStore implements DirectMessagingInboxOutbox {
  constructor(private readonly db: DatabaseSync, private readonly instanceId: string) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS direct_messaging_inbox (
        instance_id TEXT NOT NULL,
        receiving_account_id TEXT NOT NULL,
        provider_message_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY(instance_id, receiving_account_id, provider_message_id)
      );
      CREATE TABLE IF NOT EXISTS direct_messaging_outbox (
        outbox_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        state TEXT NOT NULL,
        next_attempt_at TEXT
      );
    `);
  }

  async admitInbox(record: DirectMessageInboxRecord): Promise<{ admitted: boolean; record: DirectMessageInboxRecord }> {
    const key = [record.instanceId, record.receivingAccountId, record.providerMessageId];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT payload FROM direct_messaging_inbox WHERE instance_id=? AND receiving_account_id=? AND provider_message_id=?').get(...key) as { payload: string } | undefined;
      if (row) {
        this.db.exec('COMMIT');
        return { admitted: false, record: JSON.parse(row.payload) };
      }
      this.db.prepare('INSERT INTO direct_messaging_inbox VALUES (?,?,?,?)').run(...key, JSON.stringify(record));
      this.db.exec('COMMIT');
      return { admitted: true, record };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async enqueueOutbox(record: DirectMessageOutboxRecord): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO direct_messaging_outbox (outbox_id, payload, state, next_attempt_at) VALUES (?,?,?,?)')
      .run(record.outboxId, JSON.stringify(record), record.state, record.nextAttemptAt || null);
  }

  async claimOutbox(now: string): Promise<DirectMessageOutboxRecord | null> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT outbox_id, payload FROM direct_messaging_outbox WHERE state IN ('pending', 'retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY rowid ASC LIMIT 1").get(now) as { outbox_id: string; payload: string } | undefined;
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      const record: DirectMessageOutboxRecord = JSON.parse(row.payload);
      record.state = 'sending';
      this.db.prepare('UPDATE direct_messaging_outbox SET state=?, payload=? WHERE outbox_id=?').run('sending', JSON.stringify(record), row.outbox_id);
      this.db.exec('COMMIT');
      return record;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async completeOutbox(outboxId: string, result: { state: 'sent' | 'retry' | 'uncertain' | 'failed'; nextAttemptAt?: string }): Promise<void> {
    const row = this.db.prepare('SELECT payload FROM direct_messaging_outbox WHERE outbox_id=?').get(outboxId) as { payload: string } | undefined;
    if (row) {
      const record: DirectMessageOutboxRecord = JSON.parse(row.payload);
      record.state = result.state;
      if (result.nextAttemptAt) record.nextAttemptAt = result.nextAttemptAt;
      this.db.prepare('UPDATE direct_messaging_outbox SET state=?, payload=?, next_attempt_at=? WHERE outbox_id=?')
        .run(result.state, JSON.stringify(record), result.nextAttemptAt || null, outboxId);
    }
  }
}

export class PersistentMessagingWorker {
  readonly directory: string;
  private readonly database?: DatabaseSync;
  readonly store: DirectMessagingInboxOutbox;
  private intervalHandle?: NodeJS.Timeout;
  private stopping = false;

  constructor(private readonly config: PersistentMessagingWorkerConfiguration) {
    if (config.store) {
      this.directory = config.dataDirectory || '';
      this.store = config.store;
    } else {
      const rawDir = config.dataDirectory ?? process.env.UBEEQ_MESSAGING_DATA_DIRECTORY;
      if (!rawDir || !isAbsolute(rawDir)) {
        throw new Error('UBEEQ_MESSAGING_DATA_DIRECTORY must be an absolute persistent-volume path.');
      }
      this.directory = rawDir;
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      this.database = new DatabaseSync(join(this.directory, 'messaging.sqlite'));
      this.database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
      this.store = new InternalSqliteDirectMessagingStore(this.database, config.instanceId);
    }
  }

  start(): void {
    if (!this.config.whatsapp.phoneNumberId || !this.config.whatsapp.accessToken) return;
    const worker = createDirectMessagingDeliveryWorker({
      instanceId: this.config.instanceId,
      store: this.store,
      ports: this.config.ports,
      sender: {
        phoneNumberId: this.config.whatsapp.phoneNumberId,
        accessToken: this.config.whatsapp.accessToken,
        graphApiVersion: this.config.whatsapp.graphApiVersion || 'v20.0',
      },
    });

    this.intervalHandle = setInterval(async () => {
      if (this.stopping) return;
      try {
        await worker.tick();
      } catch (error) {
        console.error('Persistent messaging worker tick failed:', error);
      }
    }, this.config.tickIntervalMs ?? 5000);
    this.intervalHandle.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    if (this.database) this.database.close();
  }
}
