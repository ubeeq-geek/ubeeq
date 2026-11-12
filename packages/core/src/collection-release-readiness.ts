import { announcementDestinationKey, announcementInstant, assertAnnouncementId, AnnouncementOrchestrationError } from "./announcement-orchestration.js";
import type { AnnouncementDestinationBinding, AnnouncementHold } from "./announcement-orchestration.js";
import { historicalPublicUrl } from "./historical-announcements.js";

export type CollectionReleaseReadinessRule = { mode: "all_required" } | { mode: "primary_destination"; destinationKey: string };
/** One manifest entry per exact publication copy, work revision and placement. Persist in bounded chunks. */
export interface CollectionReleaseRequirement {
  resultId: string;
  publicationId: string;
  workId: string;
  target: AnnouncementDestinationBinding;
  contentRevision: string;
  collectionRevision: string;
  placementId: string;
  audience: string;
  required: boolean;
  kind: "native" | "website" | "external_gallery" | "collection_forum" | "adapter";
  deploymentRevision?: string;
  /** Exact complete component/body snapshot for compositional content. */
  representationId?: string;
}
/** Only adapters reading authoritative publication state may construct these observations. */
export interface CollectionReleaseObservation {
  releaseId: string;
  resultId: string;
  publicationId: string;
  workId: string;
  target: AnnouncementDestinationBinding;
  contentRevision: string;
  collectionRevision: string;
  placementId: string;
  audience: string;
  observedAt: string;
  state: "pending" | "failed" | "unknown" | "unsupported" | "confirmed";
  evidence?: {
    reference: string;
    publishedAt: string;
    /** A live post alone is insufficient: exact collection inclusion must be verified. */
    publicationLive: boolean;
    placementConfirmed: boolean;
    audienceAvailable: boolean;
    availableAt?: string;
    durableUrl?: string;
    kind: CollectionReleaseRequirement["kind"];
    activeDeploymentRevision?: string;
    requiredMessagesConfirmed?: boolean;
    remoteIds?: readonly string[];
    /** Explicit verification capability for a future adapter. */
    revisionCompletionSupported?: boolean;
  };
}
export interface CollectionReleaseLinkDependency {
  label: string;
  destinationKey: string;
  /** All expected results for this link's selected scope, never just a provider name. */
  resultIds: readonly string[];
}
export interface CollectionReleaseReadiness {
  ready: boolean;
  confirmedResultIds: string[];
  requiredResultCount: number;
  confirmedRequiredResultCount: number;
  expectedWorkCount: number;
  confirmedWorkCount: number;
  holds: AnnouncementHold[];
}
export function validateCollectionReleaseRequirements(requirements: readonly CollectionReleaseRequirement[]): void {
  const ids = new Set<string>();
  const copies = new Set<string>();
  for (const r of requirements) {
    [r.resultId, r.publicationId, r.workId, r.contentRevision, r.collectionRevision, r.placementId, r.audience].forEach(assertAnnouncementId);
    const key = JSON.stringify([r.publicationId, announcementDestinationKey(r.target), r.contentRevision, r.collectionRevision, r.placementId]);
    if (ids.has(r.resultId) || copies.has(key) || typeof r.required !== "boolean" || !["native", "website", "external_gallery", "collection_forum", "adapter"].includes(r.kind))
      throw new AnnouncementOrchestrationError("INVALID_INPUT", "Release results must identify unique publication copies and exact revisions.");
    if (r.kind === "website") assertAnnouncementId(r.deploymentRevision!);
    ids.add(r.resultId); copies.add(key);
  }
}
/** This function does not consume events or job-success flags. Reconcile authoritative state before calling. */
export function evaluateCollectionReleaseReadiness(input: {
  releaseId: string;
  requirements: readonly CollectionReleaseRequirement[];
  observations: readonly CollectionReleaseObservation[];
  rule: CollectionReleaseReadinessRule;
  links?: readonly CollectionReleaseLinkDependency[];
  now: string;
}): CollectionReleaseReadiness {
  assertAnnouncementId(input.releaseId);
  validateCollectionReleaseRequirements(input.requirements);
  const now = announcementInstant(input.now), holds: AnnouncementHold[] = [];
  const requirements = new Map(input.requirements.map(r => [r.resultId, r]));
  // Ambiguous duplicate observations fail closed, rather than letting input order select evidence.
  const observations = new Map<string, CollectionReleaseObservation>();
  const duplicate = new Set<string>();
  for (const o of input.observations) {
    if (o.releaseId !== input.releaseId) continue;
    if (observations.has(o.resultId)) duplicate.add(o.resultId);
    observations.set(o.resultId, o);
  }
  const selected = input.requirements.filter(r => input.rule.mode === "all_required" ? r.required : announcementDestinationKey(r.target) === input.rule.destinationKey);
  if (input.rule.mode !== "all_required" && input.rule.mode !== "primary_destination")
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "Choose a supported completion rule.");
  if (!selected.length) holds.push({ code: "PUBLICATION_PENDING", message: "No expected publication results are selected. Review the release scope." });
  const confirmed = new Set<string>();
  const reasons = new Map<string, AnnouncementHold>();
  for (const r of input.requirements) {
    const o = observations.get(r.resultId);
    let code: AnnouncementHold["code"] = "PUBLICATION_PENDING";
    let valid = false;
    try {
      if (o && !duplicate.has(r.resultId)) {
        const matches = o.publicationId === r.publicationId && o.workId === r.workId && announcementDestinationKey(o.target) === announcementDestinationKey(r.target)
          && o.contentRevision === r.contentRevision && o.collectionRevision === r.collectionRevision && o.placementId === r.placementId && o.audience === r.audience;
        const e = o.evidence;
        if (!matches) code = "SOURCE_CHANGED";
        else if (o.state === "failed") code = "PUBLICATION_FAILED";
        else if (o.state === "unknown") code = "OUTCOME_UNKNOWN";
        else if (o.state === "unsupported") code = "DESTINATION_UNAVAILABLE";
        else if (o.state === "confirmed" && e) {
          valid = e.kind === r.kind && Boolean(e.reference?.trim()) && e.publicationLive === true && e.placementConfirmed === true && e.audienceAvailable === true
            && announcementInstant(o.observedAt) <= now && announcementInstant(e.publishedAt) <= now
            && announcementInstant(e.publishedAt) <= announcementInstant(o.observedAt)
            && (e.availableAt === undefined || announcementInstant(e.availableAt) <= now);
          if (r.kind === "website") valid &&= e.activeDeploymentRevision === r.deploymentRevision && isDurableAnnouncementUrl(e.durableUrl);
          if (r.kind === "collection_forum") valid &&= e.requiredMessagesConfirmed === true && Boolean(e.remoteIds?.length) && e.remoteIds!.every(id => typeof id === "string" && Boolean(id.trim()));
          if (r.kind === "adapter") valid &&= e.revisionCompletionSupported === true;
        }
      }
    } catch { valid = false; }
    if (valid) confirmed.add(r.resultId);
    else reasons.set(r.resultId, { code, resultId: r.resultId, destinationKey: announcementDestinationKey(r.target), message: `Confirm publication, revision and collection placement for ${r.workId}; review or retry this publication result.` });
  }
  const requiredIds = new Set(selected.map(r => r.resultId));
  for (const link of input.links ?? []) {
    if (!link.label?.trim() || new Set(link.resultIds).size !== link.resultIds.length)
      throw new AnnouncementOrchestrationError("INVALID_INPUT", "Each content link requires a label and an exact publication scope.");
    // A configured destination may be absent from this frozen release scope.
    // Keep its link blocked and visible instead of failing the reconciliation sweep.
    let available = link.resultIds.length > 0;
    for (const id of link.resultIds) {
      const r = requirements.get(id), o = observations.get(id);
      if (!r || announcementDestinationKey(r.target) !== link.destinationKey || !confirmed.has(id) || !isDurableAnnouncementUrl(o?.evidence?.durableUrl)) available = false;
      if (r) requiredIds.add(id);
    }
    if (!available) holds.push({ code: "LINK_NOT_READY", destinationKey: link.destinationKey, message: `The ${link.label} link is not ready. Confirm its complete publication scope and durable URL.` });
  }
  for (const id of requiredIds) if (!confirmed.has(id)) holds.push(reasons.get(id)!);
  const works = new Map<string, boolean>();
  for (const id of requiredIds) {
    const workId = requirements.get(id)!.workId;
    works.set(workId, (works.get(workId) ?? true) && confirmed.has(id));
  }
  const confirmedWorkCount = [...works.values()].filter(Boolean).length;
  return { ready: holds.length === 0, confirmedResultIds: [...confirmed], requiredResultCount: requiredIds.size,
    confirmedRequiredResultCount: [...requiredIds].filter(id => confirmed.has(id)).length, expectedWorkCount: works.size, confirmedWorkCount, holds };
}
/** Reject credential-bearing links rather than silently changing a required link. Hosts still enforce access policy. */
export function isDurableAnnouncementUrl(value: unknown): value is string {
  try {
    if (typeof value !== "string" || value.length > 16384) return false;
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
    // Reuse the existing credential-free URL policy, including nested redirect links.
    return historicalPublicUrl(url.href) === url.href;
  } catch { return false; }
}
