/** Metadata catalogue record, not authorization to read its storage key. */
export interface CreatorSourceFileRecord {
  fileId: string; creatorId: string; sourceKind: string; mimeType: string;
  storageKey: string; createdAt: string; updatedAt: string; sizeBytes?: number;
}
export interface CreatorSourceFilePort<F extends CreatorSourceFileRecord> {
  /** Compatibility read; adapters remain responsible for bounded/scoped enumeration. */
  listAllSourceFiles(): Promise<F[]>;
  /** Compatibility persistence; collision semantics remain adapter-owned. */
  createSourceFile(file: F): Promise<void>;
}
export class CreatorSourceFileError extends Error {
  constructor(readonly code: 'access_denied' | 'invalid_file', message: string) { super(message); this.name = 'CreatorSourceFileError'; }
}
/** Bind the store to one tenant. Products own roles, fields and custody admission. */
export class CreatorSourceFileService<F extends CreatorSourceFileRecord> {
  constructor(private readonly store: CreatorSourceFilePort<F>,
    private readonly authorize: (creatorId: string, operation: 'read' | 'write') => Promise<boolean>) {}
  async list(): Promise<F[]> {
    const records = structuredClone(await this.store.listAllSourceFiles());
    const allowed = new Map<string, boolean>();
    const result: F[] = [];
    for (const record of records) {
      if (typeof record.creatorId !== 'string' || !record.creatorId.trim()) continue;
      if (!allowed.has(record.creatorId)) allowed.set(record.creatorId, await this.authorize(record.creatorId, 'read'));
      if (allowed.get(record.creatorId)) result.push(record);
    }
    return result;
  }
  async create(creatorId: string, file: F): Promise<F> {
    const copy = structuredClone(file);
    if (!creatorId || !await this.authorize(creatorId, 'write')) throw new CreatorSourceFileError('access_denied', 'Source file access denied.');
    if (copy.creatorId !== creatorId || ['fileId', 'sourceKind', 'mimeType', 'storageKey', 'createdAt', 'updatedAt'].some(key => {
      const value = copy[key as keyof F]; return typeof value !== 'string' || !value.trim();
    }) || (copy.sizeBytes !== undefined && (!Number.isFinite(copy.sizeBytes) || copy.sizeBytes < 0))) {
      throw new CreatorSourceFileError('invalid_file', 'Invalid source file metadata.');
    }
    await this.store.createSourceFile(structuredClone(copy));
    return copy;
  }
}
