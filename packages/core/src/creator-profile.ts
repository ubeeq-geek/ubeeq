export interface CreatorProfileFields {
  displayName: string;
  bio?: string;
  links?: readonly { label: string; url: string }[];
}
export interface CreatorProfileRecord extends CreatorProfileFields { id: string; instanceId: string; revision: number }
export interface CreatorProfilePort<T extends CreatorProfileRecord> {
  get(id: string): Promise<T | undefined>;
  /** Must atomically compare the stored revision and advance it, or reject without writing. */
  commit(id: string, expectedRevision: number, fields: Partial<CreatorProfileFields>): Promise<T>;
}
export class CreatorProfileError extends Error {
  constructor(readonly code: 'access_denied' | 'not_found' | 'invalid_profile' | 'revision_conflict', message: string) { super(message); this.name = 'CreatorProfileError'; }
}
/** Plain-text profile fields only. Products own visibility, themes and handle reservations. */
export class CreatorProfileService<T extends CreatorProfileRecord> {
  constructor(private readonly port: CreatorProfilePort<T>, private readonly authorize: (creator: T) => Promise<boolean>) {}
  async update(instanceId: string, id: string, expectedRevision: number, input: Partial<CreatorProfileFields>): Promise<T> {
    const creator = await this.port.get(id);
    if (!creator || creator.instanceId !== instanceId) throw new CreatorProfileError('not_found', 'Creator not found.');
    if (!await this.authorize(structuredClone(creator))) throw new CreatorProfileError('access_denied', 'Creator profile access denied.');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new CreatorProfileError('invalid_profile', 'Expected revision is required.');
    if (creator.revision !== expectedRevision) throw new CreatorProfileError('revision_conflict', 'Creator profile changed; refresh before saving.');
    const invalid = () => new CreatorProfileError('invalid_profile', 'Profile fields are invalid.');
    const fields: Partial<CreatorProfileFields> = {};
    if (input.displayName !== undefined) {
      if (typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.trim().length > 300) throw invalid();
      fields.displayName = input.displayName.trim();
    }
    if (input.bio !== undefined) {
      if (typeof input.bio !== 'string' || input.bio.length > 5000) throw invalid();
      fields.bio = input.bio.trim();
    }
    if (input.links !== undefined) {
      if (!Array.isArray(input.links) || input.links.length > 20) throw invalid();
      fields.links = input.links.map(link => {
        if (!link || typeof link.label !== 'string' || !link.label.trim() || link.label.length > 200 || typeof link.url !== 'string' || link.url.length > 2048) throw invalid();
        let url: URL;
        try { url = new URL(link.url); } catch { throw invalid(); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw invalid();
        return { label: link.label.trim(), url: url.href };
      });
    }
    if (!Object.keys(fields).length) throw invalid();
    return structuredClone(await this.port.commit(id, expectedRevision, fields));
  }
}
