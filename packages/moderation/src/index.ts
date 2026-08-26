/** Neutral evidence and human-review lifecycle. Product policy evaluates evidence separately. */
export interface ModerationEvidence {
  id: string;
  subjectId: string;
  source: string;
  kind: string;
  recordedAt: string;
  attributes?: Record<string, unknown>;
}

export interface ReviewHold {
  id: string;
  subjectId: string;
  active: boolean;
  sourceId: string;
  reasonCode: string;
  createdAt: string;
  releasedAt?: string;
}

/** A subject that must be clear before an operation can proceed. */
export interface AdmissionTarget {
  subjectId: string;
}

/**
 * Provider-neutral result of evaluating active review holds.
 *
 * A product decides which holds to create, what their reason codes mean, and
 * how people remediate them. This contract only makes that existing state
 * usable by queues, API handlers, and connector adapters in a consistent way.
 */
export interface AdmissionDecision {
  allowed: boolean;
  blockedSubjectIds: readonly string[];
  activeHoldReasonCodes: readonly string[];
}

export class AdmissionBlockedError extends Error {
  readonly decision: AdmissionDecision;

  constructor(decision: AdmissionDecision, operation?: string) {
    super(operation
      ? `${operation} is blocked by an active review hold.`
      : "Operation is blocked by an active review hold.");
    this.name = "AdmissionBlockedError";
    this.decision = decision;
  }
}

/**
 * Evaluates whether every requested subject is free from an active hold.
 * Holds outside the supplied target set are intentionally ignored so callers
 * can evaluate a concrete operation without accidentally applying instance-
 * wide product policy.
 */
export const evaluateAdmission = (
  targets: readonly AdmissionTarget[],
  holds: readonly ReviewHold[]
): AdmissionDecision => {
  const targetIds = new Set(targets.map(({ subjectId }) => subjectId).filter(Boolean));
  const activeHolds = holds.filter((hold) => hold.active && targetIds.has(hold.subjectId));
  const blockedSubjectIds = [...new Set(activeHolds.map((hold) => hold.subjectId))].sort();
  const activeHoldReasonCodes = [...new Set(activeHolds.map((hold) => hold.reasonCode))].sort();
  return {
    allowed: activeHolds.length === 0,
    blockedSubjectIds,
    activeHoldReasonCodes
  };
};

/** Throws a typed error when a caller must stop a queued or immediate operation. */
export const requireAdmission = (
  targets: readonly AdmissionTarget[],
  holds: readonly ReviewHold[],
  operation?: string
): void => {
  const decision = evaluateAdmission(targets, holds);
  if (!decision.allowed) throw new AdmissionBlockedError(decision, operation);
};

export type ReviewCaseStatus = "open" | "assigned" | "decided";
export type ReviewCaseOutcome = "cleared" | "confirmed" | "escalated";

export interface ReviewCase {
  id: string;
  subjectId: string;
  sourceId: string;
  evidenceIds: readonly string[];
  status: ReviewCaseStatus;
  assignedReviewerId?: string;
  outcome?: ReviewCaseOutcome;
  rationale?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface ModerationAuditEvent {
  id: string;
  subjectId: string;
  action: string;
  actorId?: string;
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

export const assignReviewCase = (reviewCase: ReviewCase, reviewerId: string): ReviewCase => {
  if (reviewCase.status === "decided") throw new Error("A decided review case cannot be assigned");
  if (!reviewerId.trim()) throw new Error("A reviewer is required");
  return { ...reviewCase, status: "assigned", assignedReviewerId: reviewerId };
};

export const decideReviewCase = (
  reviewCase: ReviewCase,
  input: { outcome: ReviewCaseOutcome; rationale: string; reviewerId: string; decidedAt: string }
): ReviewCase => {
  if (reviewCase.status === "decided") throw new Error("A review case can only be decided once");
  if (!input.rationale.trim() || !input.reviewerId.trim()) throw new Error("A reviewer and rationale are required");
  return { ...reviewCase, status: "decided", assignedReviewerId: input.reviewerId, outcome: input.outcome, rationale: input.rationale.trim(), decidedAt: input.decidedAt };
};
