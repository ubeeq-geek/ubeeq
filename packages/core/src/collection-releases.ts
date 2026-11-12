import { announcementDestinationKey, assertAnnouncementId, AnnouncementOrchestrationError } from "./announcement-orchestration.js";
import type { AnnouncementScope } from "./announcement-orchestration.js";
import type { CollectionReleaseRequirement, CollectionReleaseReadinessRule, CollectionReleaseObservation } from "./collection-release-readiness.js";
import { evaluateCollectionReleaseReadiness } from "./collection-release-readiness.js";

export interface CollectionReleaseManifestReference {
  generation: number;
  chunkCount: number;
  resultCount: number;
  checksumSha256: string;
}
export interface CollectionRelease extends AnnouncementScope {
  /** Absent on legacy Collection records. No synthetic catalogue unit is required for Works. */
  subject?: import('./content-workflows.js').ContentReleaseSubject;
  schemaVersion: 1;
  releaseId: string;
  operationKey: string;
  revision: number;
  collectionRevision: string;
  kind?: "initial" | "additions";
  /** Work/result membership lives in the complete, checksummed manifest generation. */
  manifest: CollectionReleaseManifestReference;
  readinessRule: CollectionReleaseReadinessRule;
  state: "waiting" | "ready" | "failed" | "cancelled";
  readyAt?: string;
  remainderOfReleaseId?: string;
  createdAt: string;
  updatedAt: string;
}
export interface CollectionReleaseReservation {
  releaseId: string;
  kind: "initial" | "additions";
  workIds: readonly string[];
}
export interface CollectionReleasedWorkEvidence {
  workId: string;
  destinationKey: string;
  contentRevision: string;
  evidenceReference: string;
}
/** Logical aggregate only. Adapters MUST chunk released works, evidence and reservations on disk. */
export interface CollectionReleaseBaseline extends AnnouncementScope {
  schemaVersion: 1;
  revision: number;
  initialized: boolean;
  releasedWorkIds: readonly string[];
  evidence: readonly CollectionReleasedWorkEvidence[];
  initialReleaseId?: string;
  initialClaimReleaseId?: string;
  reservations: readonly CollectionReleaseReservation[];
}
export type CollectionReleaseClaim =
  | { state: "reserved"; reservation: CollectionReleaseReservation; baseline: CollectionReleaseBaseline }
  | { state: "waiting"; blockingReleaseIds: string[]; baseline: CollectionReleaseBaseline }
  | { state: "noop"; baseline: CollectionReleaseBaseline };

function assertBaseline(baseline: CollectionReleaseBaseline, expectedRevision: number): void {
  [baseline.tenantId, baseline.creatorId, baseline.collectionId].forEach(assertAnnouncementId);
  if (baseline.schemaVersion !== 1 || !Number.isSafeInteger(baseline.revision) || baseline.revision < 0 || baseline.revision !== expectedRevision)
    throw new AnnouncementOrchestrationError("GENERATION_CONFLICT", "The release baseline changed. Reload and retry the same operation.");
  if (!baseline.initialized)
    throw new AnnouncementOrchestrationError("REVIEW_REQUIRED", "Reconcile existing published content before enabling collection automation.");
}
/** Pure conditional-write proposal. Persist the returned baseline with CAS before creating any plan. */
export function reserveCollectionRelease(input: {
  baseline: CollectionReleaseBaseline;
  expectedRevision: number;
  releaseId: string;
  requestedWorkIds: readonly string[];
  /** Work subjects may release new components under an existing Work identity. */
  requestedRevisions?: readonly {workId:string;contentRevision:string}[];
}): CollectionReleaseClaim {
  const { baseline: b, releaseId } = input;
  assertBaseline(b, input.expectedRevision); assertAnnouncementId(releaseId);
  input.requestedWorkIds.forEach(assertAnnouncementId);
  if (new Set(input.requestedWorkIds).size !== input.requestedWorkIds.length)
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "Release work scope must be unique.");
  const existing = b.reservations.find(r => r.releaseId === releaseId);
  if (existing) return { state: "reserved", reservation: structuredClone(existing), baseline: structuredClone(b) };
  if (b.initialClaimReleaseId && b.initialClaimReleaseId !== releaseId)
    return { state: "waiting", blockingReleaseIds: [b.initialClaimReleaseId], baseline: structuredClone(b) };
  const released = new Set(b.releasedWorkIds);
  const candidates = input.requestedWorkIds.filter(id => !released.has(id)||input.requestedRevisions?.some(r=>r.workId===id&&!b.evidence.some(e=>e.workId===id&&e.contentRevision===r.contentRevision)));
  if (!candidates.length) return { state: "noop", baseline: structuredClone(b) };
  const blocking = b.reservations.filter(r => r.workIds.some(id => candidates.includes(id)));
  // Wait for overlap to settle, so an unrelated subset cannot silently replace the approved scope.
  if (blocking.length) return { state: "waiting", blockingReleaseIds: blocking.map(r => r.releaseId), baseline: structuredClone(b) };
  const reservation: CollectionReleaseReservation = { releaseId, kind: b.initialReleaseId || released.size ? "additions" : "initial", workIds: candidates };
  return { state: "reserved", reservation, baseline: {
    ...structuredClone(b), revision: b.revision + 1,
    initialClaimReleaseId: reservation.kind === "initial" ? releaseId : b.initialClaimReleaseId,
    reservations: [...structuredClone(b.reservations), reservation],
  } };
}
/** Advance the baseline on confirmed exposure, independently of announcement delivery or overall readiness. */
export function recordCollectionReleaseExposure(input: {
  baseline: CollectionReleaseBaseline;
  expectedRevision: number;
  releaseId: string;
  requirements: readonly CollectionReleaseRequirement[];
  observations: readonly CollectionReleaseObservation[];
  now: string;
}): CollectionReleaseBaseline {
  const b = input.baseline;
  assertBaseline(b, input.expectedRevision);
  const reservation = b.reservations.find(r => r.releaseId === input.releaseId);
  if (!reservation && input.requirements.some(r => !b.releasedWorkIds.includes(r.workId)))
    throw new AnnouncementOrchestrationError("GENERATION_CONFLICT", "Reserve this release before recording new exposure.");
  const evaluated = evaluateCollectionReleaseReadiness({ ...input, rule: { mode: "all_required" } });
  const confirmed = new Set(evaluated.confirmedResultIds);
  const released = new Set(b.releasedWorkIds), evidence = new Map(b.evidence.map(e => [JSON.stringify([e.workId, e.destinationKey, e.contentRevision]), e]));
  let changed = false;
  for (const r of input.requirements) {
    if (!confirmed.has(r.resultId) || !b.releasedWorkIds.includes(r.workId) && !reservation?.workIds.includes(r.workId)) continue;
    const o = input.observations.find(o => o.releaseId === input.releaseId && o.resultId === r.resultId)!;
    const e: CollectionReleasedWorkEvidence = { workId: r.workId, destinationKey: announcementDestinationKey(r.target), contentRevision: r.contentRevision, evidenceReference: o.evidence!.reference };
    const key = JSON.stringify([e.workId, e.destinationKey, e.contentRevision]);
    if (!evidence.has(key)) { evidence.set(key, e); changed = true; }
    if (!released.has(r.workId)) { released.add(r.workId); changed = true; }
  }
  if (!changed) return structuredClone(b);
  return { ...structuredClone(b), revision: b.revision + 1, releasedWorkIds: [...released], evidence: [...evidence.values()],
    initialReleaseId: b.initialReleaseId ?? (released.size ? input.releaseId : undefined),
    initialClaimReleaseId: released.size && b.initialClaimReleaseId === input.releaseId ? undefined : b.initialClaimReleaseId };
}
/** Publication termination frees unexposed claims. Confirmed exposure is monotonic, including after cancellation. */
export function finishCollectionReleaseReservation(b: CollectionReleaseBaseline, expectedRevision: number, releaseId: string): CollectionReleaseBaseline {
  assertBaseline(b, expectedRevision);
  if (!b.reservations.some(r => r.releaseId === releaseId)) return structuredClone(b);
  return { ...structuredClone(b), revision: b.revision + 1,
    initialClaimReleaseId: b.initialClaimReleaseId === releaseId ? undefined : b.initialClaimReleaseId,
    reservations: b.reservations.filter(r => r.releaseId !== releaseId).map(r => structuredClone(r)) };
}
