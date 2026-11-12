import type { MailingRecord, MailingRepository, PhotographyRepository, PhotographyState } from './types.js';
import { MailingListError, PhotographyError } from './errors.js';

export class InMemoryMailingRepository implements MailingRepository {
  private readonly records = new Map<string, MailingRecord>();

  private key(creator: string, kind: string, id: string): string {
    return `${creator}:${kind}:${id}`;
  }

  async get<T extends MailingRecord>(creator: string, kind: string, id: string): Promise<T | undefined> {
    const item = this.records.get(this.key(creator, kind, id));
    return item ? (JSON.parse(JSON.stringify(item)) as T) : undefined;
  }

  async save(creator: string, kind: string, value: MailingRecord, expected: number): Promise<void> {
    const k = this.key(creator, kind, value.id);
    const existing = this.records.get(k);
    if ((existing ? existing.revision : 0) !== expected) {
      throw new MailingListError(409, 'Concurrent modification conflict.');
    }
    this.records.set(k, JSON.parse(JSON.stringify(value)));
  }

  async list<T extends MailingRecord>(creator: string, kind: string, after?: string): Promise<{ items: T[]; next?: string }> {
    const prefix = `${creator}:${kind}:`;
    const matching: T[] = [];
    for (const [k, v] of this.records.entries()) {
      if (k.startsWith(prefix)) {
        matching.push(JSON.parse(JSON.stringify(v)) as T);
      }
    }
    matching.sort((a, b) => a.id.localeCompare(b.id));

    let startIndex = 0;
    if (after) {
      const idx = matching.findIndex((item) => item.id === after);
      if (idx >= 0) startIndex = idx + 1;
    }

    const pageSize = 50;
    const items = matching.slice(startIndex, startIndex + pageSize);
    const next = startIndex + pageSize < matching.length ? items[items.length - 1].id : undefined;

    return { items, next };
  }
}

export class InMemoryPhotographyRepository implements PhotographyRepository {
  private readonly states = new Map<string, PhotographyState>();

  async get(creatorId: string): Promise<PhotographyState | undefined> {
    const state = this.states.get(creatorId);
    return state ? (JSON.parse(JSON.stringify(state)) as PhotographyState) : undefined;
  }

  async save(creatorId: string, state: PhotographyState, expected: number): Promise<void> {
    const existing = this.states.get(creatorId);
    if ((existing ? existing.revision : 0) !== expected) {
      throw new PhotographyError(409, 'Concurrent modification conflict.');
    }
    this.states.set(creatorId, JSON.parse(JSON.stringify(state)));
  }
}
