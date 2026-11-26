import type { AnnouncementScope, CollectionReleaseRequirement, CollectionReleaseObservation } from "@ubeeq/core";

/** Declared per adapter/account; a successful upload or job submission never implies these capabilities. */
export interface CollectionReleaseCompletionCapability {
  schemaVersion: 1;
  exactContentRevision: boolean;
  collectionPlacement: boolean;
  effectiveAudience: boolean;
  activeDeploymentRevision: boolean;
  requiredContentMessages: boolean;
}
export interface CollectionReleaseCompletionRequest extends AnnouncementScope {
  releaseId: string;
  requirement: CollectionReleaseRequirement;
}
/** Implementations read current authoritative state and return actual identities/revisions, never echo expected ones as proof. */
export interface CollectionReleaseCompletionAdapter {
  capability(request: CollectionReleaseCompletionRequest): Promise<CollectionReleaseCompletionCapability>;
  observe(request: CollectionReleaseCompletionRequest): Promise<CollectionReleaseObservation>;
}
export function supportsCollectionReleaseCompletion(capability: CollectionReleaseCompletionCapability, requirement: CollectionReleaseRequirement): boolean {
  return ["native", "website", "external_gallery", "collection_forum", "adapter"].includes(requirement.kind)
    && capability.schemaVersion === 1 && capability.exactContentRevision === true && capability.collectionPlacement === true && capability.effectiveAudience === true
    && (requirement.kind !== "website" || capability.activeDeploymentRevision === true)
    && (requirement.kind !== "collection_forum" || capability.requiredContentMessages === true);
}
/** Events are durable hints. Receivers must reread authoritative state; imports cannot produce these events. */
export interface CollectionReleaseOutcomeEvent extends AnnouncementScope {
  eventId: string;
  releaseId: string;
  resultId: string;
  publicationId: string;
  expectedContentRevision: string;
  occurredAt: string;
  source: "publication_execution" | "publication_reconciliation";
}
/** Collection content and promotional delivery ownership are independent. */
export interface CollectionAnnouncementOwnership {
  releaseId: string;
  announcementDestinationKeys: readonly string[];
}
export function collectionPlanOwnsAnnouncement(ownership: CollectionAnnouncementOwnership | undefined, releaseId: string | undefined, destinationKey: string): boolean {
  return Boolean(ownership && releaseId && ownership.releaseId === releaseId && ownership.announcementDestinationKeys.includes(destinationKey));
}
