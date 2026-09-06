import { CreatorProfileError } from './creator-profile';

export interface CreatorHandleRecord { id: string; instanceId: string; revision: number; handle: string }
export interface CreatorHandlePort<T extends CreatorHandleRecord> {
  get(id: string): Promise<T | undefined>;
  /** Atomically compare revision, retain/reserve all old aliases and reserve the new
   * handle with the record write. Reject conflicts without any partial writes. */
  commitHandle(id: string, expectedRevision: number, handle: string): Promise<T>;
}

/** Product composition supplies owner/admission policy and canonical normalization. */
export class CreatorHandleService<T extends CreatorHandleRecord> {
  constructor(private readonly port: CreatorHandlePort<T>, private readonly authorize: (creator: T) => Promise<boolean>,
    private readonly normalize: (input: string) => string) {}

  async rename(instanceId: string, id: string, expectedRevision: number, input: unknown): Promise<T> {
    const creator = await this.port.get(id);
    if (!creator || creator.id !== id || creator.instanceId !== instanceId) throw new CreatorProfileError('not_found', 'Creator not found.');
    if (!await this.authorize(structuredClone(creator))) throw new CreatorProfileError('access_denied', 'Creator handle access denied.');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new CreatorProfileError('invalid_profile', 'Expected revision is required.');
    if (creator.revision !== expectedRevision) throw new CreatorProfileError('revision_conflict', 'Creator changed; refresh before renaming.');
    if (typeof input !== 'string' || !input.trim() || input.length > 300) throw new CreatorProfileError('invalid_profile', 'Handle must contain 1–300 characters.');
    const handle = this.normalize(input);
    if (typeof handle !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle)) throw new CreatorProfileError('invalid_profile', 'Handle normalization did not produce a canonical handle.');
    return structuredClone(await this.port.commitHandle(id, expectedRevision, handle));
  }
}
