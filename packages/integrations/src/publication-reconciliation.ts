export interface PublicationReconciliationPosition { revision?: string; afterKey?: string }
export interface PublicationReconciliationStore {
  reconciliationPosition(): Promise<PublicationReconciliationPosition>;
  reconciliationStep(afterKey?: string): Promise<{ publication?: { id: string }; nextKey?: string }>;
  checkpointReconciliation(expected: PublicationReconciliationPosition, afterKey?: string): Promise<PublicationReconciliationPosition | undefined>;
}

/** One evaluated database row per checkpoint; failed items are retried on the next sweep. */
export async function runPublicationReconciliation(
  repository: PublicationReconciliationStore,
  reconcile: (id: string) => Promise<unknown>,
  canContinue: () => boolean = () => true,
  maxSteps = 100
) {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new Error('Invalid reconciliation step budget');
  let position = await repository.reconciliationPosition();
  let checked = 0, failed = 0, advanced = 0;
  while (advanced < maxSteps && canContinue()) {
    const step = await repository.reconciliationStep(position.afterKey);
    if (step.nextKey && step.nextKey === position.afterKey) throw new Error('Repeated reconciliation cursor');
    if (step.publication) {
      checked += 1;
      try { await reconcile(step.publication.id); } catch { failed += 1; }
    }
    // Checkpoint only after the attempt. A crash replays the current row, never skips it.
    const next = await repository.checkpointReconciliation(position, step.nextKey);
    if (!next) return { checked, failed, advanced, contention: true };
    position = next;
    advanced += 1;
    if (!step.nextKey) break; // End of sweep resets the next invocation to the beginning.
  }
  return { checked, failed, advanced, contention: false };
}
