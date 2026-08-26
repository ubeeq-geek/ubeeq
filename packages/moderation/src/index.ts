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

