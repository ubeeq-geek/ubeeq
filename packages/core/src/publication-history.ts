/** Snapshot contents belong to the caller; identity and append-only semantics are shared. */
export interface DisclosureSnapshotIdentity {
  attemptKey: string;
  snapshotId: string;
  fingerprintSha256: string;
}

export interface PublicationDisclosureHistory<S extends DisclosureSnapshotIdentity = DisclosureSnapshotIdentity> {
  disclosureSnapshots?: readonly S[];
  activeDisclosureSnapshotId?: string;
}

const stableSnapshotValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableSnapshotValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableSnapshotValue(item)]));
  return value;
};

/** Repeated attempts select the original snapshot; changed disclosures require a new attempt. */
export const appendPublicationDisclosureSnapshot = <S extends DisclosureSnapshotIdentity, T extends PublicationDisclosureHistory<S>>(
  publication: T,
  snapshot: S
): T => {
  const history = [...(publication.disclosureSnapshots || [])];
  const existing = history.find((item) => item.attemptKey === snapshot.attemptKey);
  if (existing) {
    if (existing.fingerprintSha256 !== snapshot.fingerprintSha256) throw new Error('Publication disclosure snapshot is immutable for this attempt.');
    return { ...publication, activeDisclosureSnapshotId: existing.snapshotId };
  }
  if (history.some((item) => item.snapshotId === snapshot.snapshotId)) throw new Error('Publication disclosure snapshot identifier is already in use.');
  return { ...publication, disclosureSnapshots: [...history, snapshot], activeDisclosureSnapshotId: snapshot.snapshotId };
};

export const assertPublicationDisclosureHistoryImmutable = (
  previous: PublicationDisclosureHistory | null | undefined,
  next: PublicationDisclosureHistory
): void => {
  if (!previous?.disclosureSnapshots?.length) return;
  const incoming = next.disclosureSnapshots || [];
  if (incoming.length < previous.disclosureSnapshots.length) throw new Error('Publication disclosure history cannot be removed.');
  previous.disclosureSnapshots.forEach((snapshot, index) => {
    if (JSON.stringify(stableSnapshotValue(snapshot)) !== JSON.stringify(stableSnapshotValue(incoming[index]))) {
      throw new Error('Publication disclosure history is immutable.');
    }
  });
};

export const activePublicationDisclosureSnapshot = <S extends DisclosureSnapshotIdentity>(publication: PublicationDisclosureHistory<S>): S | undefined =>
  publication.disclosureSnapshots?.find((snapshot) => snapshot.snapshotId === publication.activeDisclosureSnapshotId);
