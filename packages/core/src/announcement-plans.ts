import { announcementInstant, assertAnnouncementId, AnnouncementOrchestrationError } from "./announcement-orchestration.js";
import type { AnnouncementScope, AnnouncementStepKind, AnnouncementGateState, AnnouncementHold, AnnouncementOrigin, AnnouncementDeliveryStatus } from "./announcement-orchestration.js";
import type { EffectiveCollectionAnnouncementPreferences } from "./collection-announcement-preferences.js";
import type { AnnouncementScheduleEvaluation, AnnouncementLatePolicy } from "./announcement-plan-scheduler.js";
import { validateAnnouncementLatePolicy } from "./announcement-plan-scheduler.js";
import type { CollectionReleaseReadiness } from "./collection-release-readiness.js";

export interface AnnouncementPlan extends Pick<AnnouncementScope, "tenantId" | "creatorId"> {
  schemaVersion: 1;
  /** Separate from the existing authoring payload's planVersion. */
  stage: "first_delivery";
  planId: string;
  collectionId?: string;
  releaseId?: string;
  parentPlanId?: string;
  kind: AnnouncementStepKind;
  origin: Exclude<AnnouncementOrigin, "imported">;
  effectivePreferences?: EffectiveCollectionAnnouncementPreferences;
  actorId: string;
  authorizationRevision: number;
  behaviour: "draft" | "automatic";
  latePolicy: AnnouncementLatePolicy;
  gateState: AnnouncementGateState;
  holds: readonly AnnouncementHold[];
  revision: number;
  generation: number;
  releaseReadyAt?: string;
  schedule?: AnnouncementScheduleEvaluation;
  /** A reserved identifier is internal until the authoring record has been durably materialized. */
  materialization?: { announcementId: string; state: "reserved" | "materialized" };
  createdAt: string;
  updatedAt: string;
}
export function assertAnnouncementPlanRevision(plan: AnnouncementPlan, expectedRevision: number, generation = plan.generation): void {
  if (plan.revision !== expectedRevision || plan.generation !== generation || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    throw new AnnouncementOrchestrationError("GENERATION_CONFLICT", "This announcement changed. Reload its current revision before applying changes.");
}
function advance(plan: AnnouncementPlan, change: Partial<AnnouncementPlan>, now: string): AnnouncementPlan {
  announcementInstant(now);
  const next = { ...structuredClone(plan), ...structuredClone(change), revision: plan.revision + 1, updatedAt: now };
  next.holds = [...new Map(next.holds.map(h => [JSON.stringify([h.code, h.resultId, h.destinationKey, h.message, h.requiresReview]), h])).values()];
  return next;
}
/** Creates orchestration only. An imported historical record is never an outbound plan. */
export function createAnnouncementPlan(input: Omit<AnnouncementPlan, "schemaVersion" | "stage" | "gateState" | "holds" | "revision" | "generation" | "materialization" | "createdAt" | "updatedAt" | "releaseReadyAt" | "schedule"> & { now: string }): AnnouncementPlan {
  const { now, ...fields } = input;
  validateAnnouncementLatePolicy(fields.latePolicy);
  [fields.planId, fields.tenantId, fields.creatorId, fields.actorId].forEach(assertAnnouncementId);
  announcementInstant(now);
  if (!["manual", "collection_automation"].includes(fields.origin) || !["draft", "automatic"].includes(fields.behaviour)
    || !["initial", "additions", "follow_up", "ad_hoc"].includes(fields.kind) || !Number.isSafeInteger(fields.authorizationRevision) || fields.authorizationRevision < 1
    || (fields.origin === "collection_automation" && (!fields.releaseId || !fields.collectionId || !fields.effectivePreferences))
    || (fields.kind === "follow_up" && !fields.parentPlanId))
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "An authorized plan requires valid origin, trigger, parent and preference provenance.");
  if (fields.origin === "collection_automation" && (fields.kind === "initial" || fields.kind === "additions")
    && fields.effectivePreferences!.settings[fields.kind].behaviour !== fields.behaviour)
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "The plan behaviour must match its authorized preference snapshot.");
  return { ...structuredClone(fields), schemaVersion: 1, stage: "first_delivery", gateState: fields.kind === "follow_up" ? "waiting_parent" : fields.releaseId ? "waiting_publication" : "ready_to_prepare",
    holds: [], revision: 1, generation: 1, createdAt: now, updatedAt: now };
}
/** No delivery is eligible here. The host must persist this change with CAS and durable outbox intents. */
export function evaluateAnnouncementPlan(input: {
  plan: AnnouncementPlan;
  expectedRevision: number;
  readiness?: CollectionReleaseReadiness;
  schedule?: AnnouncementScheduleEvaluation;
  validationHolds?: readonly AnnouncementHold[];
  featureEnabled: boolean;
  /** A material source/account/permission change requires a new reviewed authorization. */
  reviewedAuthorizationRevision?: number;
  now: string;
}): AnnouncementPlan {
  const p = input.plan;
  assertAnnouncementPlanRevision(p, input.expectedRevision);
  announcementInstant(input.now);
  if (["completed", "cancelled"].includes(p.gateState)) return structuredClone(p);
  let authorizationRevision = p.authorizationRevision;
  if (input.reviewedAuthorizationRevision !== undefined) {
    if (!Number.isSafeInteger(input.reviewedAuthorizationRevision) || input.reviewedAuthorizationRevision <= p.authorizationRevision)
      throw new AnnouncementOrchestrationError("GENERATION_CONFLICT", "Review must record a newer authorization revision.");
    authorizationRevision = input.reviewedAuthorizationRevision;
  }
  const holds = [...(input.validationHolds ?? [])];
  if (!input.featureEnabled) holds.push({ code: "RULES_CHANGED", requiresReview: false, message: "Announcement orchestration is paused. Revalidate this plan when enabled." });
  const reviewCodes = new Set(["SOURCE_CHANGED", "DESTINATION_UNAVAILABLE", "RULES_CHANGED", "PERMISSION_CHANGED", "SCHEDULE_EXPIRED"]);
  if (p.gateState === "held" && input.reviewedAuthorizationRevision === undefined) holds.push(...p.holds.filter(h => reviewCodes.has(h.code) && h.requiresReview !== false));
  if (holds.length) return advance(p, { gateState: "held", holds, authorizationRevision }, input.now);
  if (p.kind !== "follow_up" && p.releaseId && !input.readiness?.ready) {
    const publicationHolds = input.readiness?.holds ?? [{ code: "PUBLICATION_PENDING" as const, message: "Wait for authoritative publication evidence." }];
    return advance(p, { gateState: publicationHolds.some(h => h.code !== "PUBLICATION_PENDING") ? "held" : "waiting_publication", holds: publicationHolds, authorizationRevision }, input.now);
  }
  const releaseReadyAt = p.releaseReadyAt ?? (p.releaseId && input.readiness?.ready ? input.now : undefined);
  const schedule = input.schedule;
  // A draft's computed time is informational. Prepare the review draft even if that time has passed.
  if (schedule?.state === "held" && p.behaviour === "draft")
    return advance(p, { gateState: p.materialization?.state === "materialized" ? "active" : "ready_to_prepare", holds: schedule.holds, releaseReadyAt, schedule, authorizationRevision }, input.now);
  if (schedule && (schedule.state === "held" || schedule.state === "waiting_parent" || schedule.state === "waiting_publication" || schedule.state === "cancelled"))
    return advance(p, { gateState: schedule.state === "held" ? "held" : schedule.state, holds: schedule.holds, releaseReadyAt, schedule, authorizationRevision }, input.now);
  if (p.kind === "follow_up" && !schedule)
    return advance(p, { gateState: "waiting_parent", holds: [{ code: "PARENT_NOT_SENT", message: "Resolve confirmed initial delivery before preparing this follow-up." }], authorizationRevision }, input.now);
  return advance(p, { gateState: p.materialization?.state === "materialized" ? "active" : "ready_to_prepare", holds: [], releaseReadyAt, schedule, authorizationRevision }, input.now);
}
/** Reserve once using a deterministic identity; a crash resumes creation with this same ID. */
export function reserveAnnouncementMaterialization(plan: AnnouncementPlan, expectedRevision: number, now: string): AnnouncementPlan {
  assertAnnouncementPlanRevision(plan, expectedRevision);
  if (plan.materialization) return structuredClone(plan);
  if (plan.gateState !== "ready_to_prepare") throw new AnnouncementOrchestrationError("PUBLICATION_PENDING", "Resolve this plan's publication and parent dependencies before preparing content.");
  return advance(plan, { materialization: { announcementId: `announcement:${plan.planId}`, state: "reserved" } }, now);
}
/** The host atomically creates/locates the authoring record and commits this materialized state. */
export function completeAnnouncementMaterialization(plan: AnnouncementPlan, expectedRevision: number, announcementId: string, now: string): AnnouncementPlan {
  assertAnnouncementPlanRevision(plan, expectedRevision);
  if (plan.materialization?.state === "materialized" && plan.materialization.announcementId === announcementId) return structuredClone(plan);
  if (plan.gateState !== "ready_to_prepare" || plan.materialization?.announcementId !== announcementId)
    throw new AnnouncementOrchestrationError("GENERATION_CONFLICT", "The materialization reservation changed. Reload before completing preparation.");
  return advance(plan, { gateState: plan.holds.length && plan.behaviour === "automatic" ? "held" : "active", materialization: { announcementId, state: "materialized" } }, now);
}
export interface AnnouncementDestinationStep {
  logicalStepId: string;
  destinationKey: string;
  generation: number;
  contentRevision: string;
  dueAt: string;
  state: "pending" | "sending" | "published" | "provider_draft" | "failed" | "needs_reconciliation" | "cancelled";
  deliveryId: string;
  supersedesDeliveryId?: string;
  sentAt?: string;
}
/** Call inside the conditional send claim immediately before the provider call. */
export function assertAnnouncementSendEligible(input: {
  plan: AnnouncementPlan;
  step: AnnouncementDestinationStep;
  expectedRevision: number;
  expectedGeneration: number;
  featureEnabled: boolean;
  authorizationValid: boolean;
  sourceAvailable: boolean;
  linksAvailable: boolean;
  policyAllowed: boolean;
  now: string;
}): void {
  const { plan: p, step: s } = input;
  assertAnnouncementPlanRevision(p, input.expectedRevision, input.expectedGeneration);
  if (!input.featureEnabled || p.gateState !== "active" || p.behaviour !== "automatic" || p.materialization?.state !== "materialized" || s.generation !== p.generation || s.state !== "pending")
    throw new AnnouncementOrchestrationError("GENERATION_CONFLICT", "This delivery is paused, replaced, already claimed or awaiting explicit send authorization.");
  if (!input.authorizationValid) throw new AnnouncementOrchestrationError("PERMISSION_CHANGED", "Review Creator and destination authorization before sending.");
  if (!input.sourceAvailable || !input.policyAllowed) throw new AnnouncementOrchestrationError("SOURCE_CHANGED", "Review source availability and policy before sending.");
  if (!input.linksAvailable) throw new AnnouncementOrchestrationError("LINK_NOT_READY", "Restore required content links before sending.");
  if (announcementInstant(s.dueAt) > announcementInstant(input.now)) throw new AnnouncementOrchestrationError("PUBLICATION_PENDING", "This delivery is not due. Retain its durable due-index entry.");
  if (p.schedule?.state === "held" || p.holds.length) throw new AnnouncementOrchestrationError("REVIEW_REQUIRED", "Resolve the announcement's holds before sending.");
  const policy = p.latePolicy;
  validateAnnouncementLatePolicy(policy);
  if (policy.maximumLatenessMs !== null && announcementInstant(input.now) - announcementInstant(s.dueAt) > policy.maximumLatenessMs)
    throw new AnnouncementOrchestrationError("SCHEDULE_EXPIRED", "The saved maximum lateness has passed. Review a new delivery time.");
}
/** Pure replacement proposal. CAS the plan and all selected pending requests together, retaining old tombstones. */
export function replaceUnsentAnnouncementSteps(input: {
  plan: AnnouncementPlan;
  expectedRevision: number;
  expectedGeneration: number;
  steps: readonly AnnouncementDestinationStep[];
  replacements: readonly { logicalStepId: string; dueAt: string; contentRevision: string; deliveryId: string }[];
  now: string;
}): { plan: AnnouncementPlan; steps: AnnouncementDestinationStep[]; superseded: AnnouncementDestinationStep[] } {
  const p = input.plan;
  assertAnnouncementPlanRevision(p, input.expectedRevision, input.expectedGeneration);
  if (["cancelled", "completed"].includes(p.gateState) || !input.replacements.length || new Set(input.replacements.map(r => r.logicalStepId)).size !== input.replacements.length
    || new Set(input.steps.map(s => s.logicalStepId)).size !== input.steps.length
    || new Set(input.replacements.map(r => r.deliveryId)).size !== input.replacements.length
    || input.replacements.some(r => input.steps.some(s => s.deliveryId === r.deliveryId)))
    throw new AnnouncementOrchestrationError("GENERATION_CONFLICT", "Select distinct, eligible unsent destination steps.");
  const changes = new Map(input.replacements.map(r => [r.logicalStepId, r]));
  for (const change of input.replacements) {
    announcementInstant(change.dueAt); assertAnnouncementId(change.contentRevision); assertAnnouncementId(change.deliveryId);
    const step = input.steps.find(s => s.logicalStepId === change.logicalStepId);
    if (!step || step.generation !== p.generation || !["pending", "failed"].includes(step.state) || change.deliveryId === step.deliveryId)
      throw new AnnouncementOrchestrationError(step?.state === "needs_reconciliation" ? "OUTCOME_UNKNOWN" : "GENERATION_CONFLICT", "A selected delivery is sent, sending, unresolved or replaced. Reload its current state before editing.");
  }
  // Every pending request must move together; sending and unknown requests fence replacement.
  if (input.steps.some(s => ["sending", "needs_reconciliation"].includes(s.state)) || input.steps.some(s => s.state === "pending" && !changes.has(s.logicalStepId)))
    throw new AnnouncementOrchestrationError("GENERATION_CONFLICT", "Replace all pending requests together after any in-flight or unknown outcomes are resolved.");
  const generation = p.generation + 1;
  const superseded = input.steps.filter(s => changes.has(s.logicalStepId)).map(s => ({ ...structuredClone(s), state: "cancelled" as const }));
  const steps = input.steps.map(s => {
    const change = changes.get(s.logicalStepId);
    return change ? { ...structuredClone(s), ...change, generation, state: "pending" as const, supersedesDeliveryId: s.deliveryId, sentAt: undefined } : structuredClone(s);
  });
  return { plan: advance(p, { generation }, input.now), steps, superseded };
}
/** Missing deliveries are a handoff error, not vacuous completion. */
export function aggregateAnnouncementSteps(expectedLogicalStepIds: readonly string[], steps: readonly AnnouncementDestinationStep[]): AnnouncementDeliveryStatus {
  if (!expectedLogicalStepIds.length || new Set(expectedLogicalStepIds).size !== expectedLogicalStepIds.length || new Set(steps.map(s => s.logicalStepId)).size !== steps.length || expectedLogicalStepIds.some(id => !steps.some(s => s.logicalStepId === id))) return "failed";
  const selected = steps.filter(s => expectedLogicalStepIds.includes(s.logicalStepId));
  if (selected.every(s => s.state === "published" || s.state === "provider_draft")) return "sent";
  if (selected.every(s => s.state === "cancelled")) return "cancelled";
  if (selected.some(s => s.state === "published")) return "partially_sent";
  if (selected.some(s => ["failed", "needs_reconciliation"].includes(s.state))) return "failed";
  return "queued";
}
export function announcementLogicalRow(plan: AnnouncementPlan): {
  logicalRowId: string; planId: string; announcementId?: string; gateState: AnnouncementGateState; displayStatus: string;
} {
  const labels: Record<AnnouncementGateState, string> = { waiting_publication: "Waiting for publication", waiting_parent: "Waiting for initial delivery", ready_to_prepare: "Preparing announcement", active: plan.behaviour === "draft" ? "Draft for review" : "Active", held: "Needs attention", cancelled: "Cancelled", completed: "Completed" };
  return { logicalRowId: plan.planId, planId: plan.planId, announcementId: plan.materialization?.state === "materialized" ? plan.materialization.announcementId : undefined, gateState: plan.gateState, displayStatus: labels[plan.gateState] };
}
