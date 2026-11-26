/** Versioned orchestration is separate from the existing authoring payload version. */
export const ANNOUNCEMENT_ORCHESTRATION_SCHEMA_VERSION = 1 as const;
export type AnnouncementStepKind = "initial" | "additions" | "follow_up" | "ad_hoc";
export type AnnouncementOrigin = "manual" | "collection_automation" | "imported";
export type AnnouncementGateState = "waiting_publication" | "waiting_parent" | "ready_to_prepare" | "active" | "held" | "cancelled" | "completed";
export type AnnouncementDeliveryStatus = "draft" | "ready" | "scheduled" | "queued" | "sent" | "partially_sent" | "failed" | "cancelled";
export type AnnouncementHoldCode = "PUBLICATION_PENDING" | "PUBLICATION_FAILED" | "SOURCE_CHANGED" | "LINK_NOT_READY" | "DESTINATION_UNAVAILABLE" | "RULES_CHANGED" | "PARENT_NOT_SENT" | "SCHEDULE_EXPIRED" | "PERMISSION_CHANGED" | "GENERATION_CONFLICT" | "OUTCOME_UNKNOWN";
export interface AnnouncementHold {
  code: AnnouncementHoldCode;
  message: string;
  resultId?: string;
  destinationKey?: string;
  /** False only for transient holds whose saved authorization remains valid. */
  requiresReview?: boolean;
}
export class AnnouncementOrchestrationError extends Error {
  constructor(readonly code: AnnouncementHoldCode | "INVALID_INPUT" | "REVIEW_REQUIRED", message: string) {
    super(message);
    this.name = "AnnouncementOrchestrationError";
  }
}
export interface AnnouncementScope { tenantId: string; creatorId: string; collectionId: string }
export interface AnnouncementDestinationBinding {
  provider: string;
  accountId: string;
  connectionId: string;
  targetId: string;
  postType: string;
}
export function assertAnnouncementId(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value || value.length > 1000 || /[\u0000-\u001f\u007f]/.test(value))
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "A bounded, nonempty identity is required.");
}
export function announcementInstant(value: string): number {
  // Reject local times: their interpretation must never depend on the worker's zone.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "An explicit UTC or offset timestamp is required.");
  const civil = value.slice(0, 19), local = Date.parse(`${civil}Z`);
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 19) !== civil)
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "Choose a valid calendar date and clock time.");
  return Date.parse(value);
}
export function announcementDestinationKey(binding: AnnouncementDestinationBinding): string {
  const tuple = [binding.provider, binding.accountId, binding.connectionId, binding.targetId, binding.postType];
  tuple.forEach(assertAnnouncementId);
  return JSON.stringify(tuple);
}
export function collectionReleaseOperationKey(scope: AnnouncementScope, operationKey: string): string {
  const tuple = [scope.tenantId, scope.creatorId, scope.collectionId, operationKey];
  tuple.forEach(assertAnnouncementId);
  return JSON.stringify(tuple);
}
export function announcementPlanKey(scope: Pick<AnnouncementScope, "tenantId" | "creatorId">, releaseId: string, kind: AnnouncementStepKind, ordinal = 0): string {
  [scope.tenantId, scope.creatorId, releaseId].forEach(assertAnnouncementId);
  if (!["initial", "additions", "follow_up", "ad_hoc"].includes(kind) || !Number.isSafeInteger(ordinal) || ordinal < 0)
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "Choose a valid step and ordinal.");
  return JSON.stringify([scope.tenantId, scope.creatorId, releaseId, kind, ordinal]);
}
/** Generation is intentionally excluded: replacement retains the logical step. */
export function announcementDestinationStepKey(planId: string, binding: AnnouncementDestinationBinding): string {
  assertAnnouncementId(planId);
  return JSON.stringify([planId, announcementDestinationKey(binding)]);
}
