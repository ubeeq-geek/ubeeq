import type {
  AnnouncementScope, AnnouncementPlan, AnnouncementPreferenceSet, CollectionRelease,
  CollectionReleaseBaseline, CollectionReleaseRequirement, CollectionReleaseManifestReference,
  AnnouncementDestinationStep, AnnouncementHold, AnnouncementGateState, AnnouncementOrigin, AnnouncementStepKind,
} from "@ubeeq/core";
import { assertAnnouncementId, validateCollectionReleaseRequirements, AnnouncementOrchestrationError } from "@ubeeq/core";
import { publicationIdentityHash } from "./publication-copies.js";

export interface CollectionReleaseManifestChunk extends AnnouncementScope {
  schemaVersion: 1;
  releaseId: string;
  generation: number;
  index: number;
  checksumSha256: string;
  requirements: readonly CollectionReleaseRequirement[];
}
/** Bounded well below a 400 KiB item, leaving room for adapter keys and indexing metadata. */
export const COLLECTION_RELEASE_MANIFEST_MAX_BYTES = 240 * 1024;
const digest = (chunk: Omit<CollectionReleaseManifestChunk, "checksumSha256">): string => publicationIdentityHash(chunk);
export function prepareCollectionReleaseManifest(input: AnnouncementScope & {
  releaseId: string;
  generation: number;
  requirements: readonly CollectionReleaseRequirement[];
  maximumChunkBytes?: number;
  maximumChunkResults?: number;
}): { reference: CollectionReleaseManifestReference; chunks: CollectionReleaseManifestChunk[] } {
  [input.tenantId, input.creatorId, input.collectionId, input.releaseId].forEach(assertAnnouncementId);
  validateCollectionReleaseRequirements(input.requirements);
  const maxBytes = input.maximumChunkBytes ?? COLLECTION_RELEASE_MANIFEST_MAX_BYTES, maxResults = input.maximumChunkResults ?? 100;
  if (!Number.isSafeInteger(input.generation) || input.generation < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > COLLECTION_RELEASE_MANIFEST_MAX_BYTES || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 100)
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "Choose a positive manifest generation and bounded chunk limits.");
  const chunks: CollectionReleaseManifestChunk[] = [];
  const base = { schemaVersion: 1 as const, tenantId: input.tenantId, creatorId: input.creatorId, collectionId: input.collectionId, releaseId: input.releaseId, generation: input.generation };
  let requirements: CollectionReleaseRequirement[] = [];
  const build = (items: CollectionReleaseRequirement[]) => {
    const chunk = { ...base, index: chunks.length, requirements: items };
    return { ...chunk, checksumSha256: digest(chunk) };
  };
  const size = (items: CollectionReleaseRequirement[]) => new TextEncoder().encode(JSON.stringify(build(items))).byteLength;
  const flush = () => { if (requirements.length) { chunks.push(build(requirements)); requirements = []; } };
  for (const requirement of input.requirements) {
    if (requirements.length >= maxResults || size([...requirements, requirement]) > maxBytes) flush();
    if (size([requirement]) > maxBytes) throw new AnnouncementOrchestrationError("INVALID_INPUT", "A publication result exceeds the manifest item bound.");
    requirements.push(structuredClone(requirement));
  }
  flush();
  return { reference: { generation: input.generation, chunkCount: chunks.length, resultCount: input.requirements.length,
    checksumSha256: publicationIdentityHash(chunks.map(c => c.checksumSha256)) }, chunks };
}
/** Workers may read only a complete generation referenced by an activated release header. */
export function readCollectionReleaseManifest(scope: AnnouncementScope & { releaseId: string }, reference: CollectionReleaseManifestReference, chunks: readonly CollectionReleaseManifestChunk[]): CollectionReleaseRequirement[] {
  const ordered = [...chunks].sort((a, b) => a.index - b.index);
  if (ordered.length !== reference.chunkCount || !Number.isSafeInteger(reference.chunkCount) || reference.chunkCount < 0 || !Number.isSafeInteger(reference.resultCount) || reference.resultCount < 0 || !Number.isSafeInteger(reference.generation) || reference.generation < 1)
    throw new AnnouncementOrchestrationError("GENERATION_CONFLICT", "The release manifest generation is incomplete. Reconcile staged chunks before activation.");
  for (const [index, chunk] of ordered.entries()) {
    const { checksumSha256, ...payload } = chunk;
    if (chunk.schemaVersion !== 1 || chunk.index !== index || chunk.generation !== reference.generation
      || chunk.tenantId !== scope.tenantId || chunk.creatorId !== scope.creatorId || chunk.collectionId !== scope.collectionId || chunk.releaseId !== scope.releaseId
      || digest(payload) !== checksumSha256 || new TextEncoder().encode(JSON.stringify(chunk)).length > COLLECTION_RELEASE_MANIFEST_MAX_BYTES)
      throw new AnnouncementOrchestrationError("GENERATION_CONFLICT", "The release manifest is stale, corrupt or belongs to another scope.");
  }
  const results = ordered.flatMap(c => c.requirements);
  if (results.length !== reference.resultCount || publicationIdentityHash(ordered.map(c => c.checksumSha256)) !== reference.checksumSha256)
    throw new AnnouncementOrchestrationError("GENERATION_CONFLICT", "The manifest checksum or result count changed. Reconcile before activation.");
  validateCollectionReleaseRequirements(results);
  return structuredClone(results);
}

export interface AnnouncementOutboxIntent extends Pick<AnnouncementScope, "tenantId" | "creatorId"> {
  intentId: string;
  planId?: string;
  releaseId?: string;
  generation: number;
  kind: "publish_release" | "evaluate_release" | "materialize_announcement" | "handoff_delivery";
  dueAt: string;
  state: "pending" | "acknowledged";
}
export interface CollectionAnnouncementListFilters {
  collectionId?: string;
  origin?: AnnouncementOrigin;
  kind?: AnnouncementStepKind;
  gateState?: AnnouncementGateState;
  destinationKey?: string;
  normalizedTitlePrefix?: string;
  needsAttention?: boolean;
}
export interface AnnouncementActivity extends Pick<AnnouncementScope, "tenantId" | "creatorId"> {
  activityId: string;
  planId?: string;
  releaseId?: string;
  announcementId?: string;
  actorId: string;
  operation: string;
  beforeRevision?: number;
  afterRevision: number;
  occurredAt: string;
  reason?: AnnouncementHold;
}
/** Optional capability: product storage implements this independently of legacy authoring repositories.
 * All reads are tenant/Creator scoped and strong where they authorize a transition.
 * Baseline aggregates and manifests MUST be chunked; no unbounded aggregate is a single database item.
 */
export interface CollectionAnnouncementRepository<AuthoringRecord, LogicalListRow> {
  getPreferences(scope: Pick<AnnouncementScope, "tenantId" | "creatorId"> & { collectionId?: string }): Promise<AnnouncementPreferenceSet | undefined>;
  savePreferences(preferences: AnnouncementPreferenceSet, expectedRevision: number): Promise<void>;
  /** Absent-or-identical immutable chunks; does not activate headers or dispatch work. */
  stageManifestChunks(chunks: readonly CollectionReleaseManifestChunk[]): Promise<void>;
  getBaseline(scope: AnnouncementScope): Promise<CollectionReleaseBaseline>;
  /** Unique operation key + baseline reservations + plan identity + complete manifest header + intents commit together.
   * Large baseline changes are staged into immutable generations first, then activated through CAS headers.
   * Repeated operation keys return the original release, without expanding its manifest or replacing preferences.
   */
  commitRelease(input: { release: CollectionRelease; expectedBaselineRevision: number; baseline: CollectionReleaseBaseline; plans: readonly AnnouncementPlan[]; intents: readonly AnnouncementOutboxIntent[]; activity: AnnouncementActivity }): Promise<CollectionRelease>;
  getPlan(scope: Pick<AnnouncementScope, "tenantId" | "creatorId">, planId: string): Promise<AnnouncementPlan | undefined>;
  /** Conditional transaction, including active generation and no sending/unknown claims on replaced steps.
   * Retain superseded immutable deliveries and cancellation tombstones. Do not enqueue until this commits.
   */
  commitPlan(input: { plan: AnnouncementPlan; expectedRevision: number; expectedGeneration: number; steps: readonly AnnouncementDestinationStep[]; superseded: readonly AnnouncementDestinationStep[]; intents: readonly AnnouncementOutboxIntent[]; activity: AnnouncementActivity }): Promise<void>;
  /** Atomically create-or-find the reserved authoring ID, link the plan and SWITCH its single logical projection.
   * Existing legacy rows remain available. A repeated reservation cannot create a second authoring record.
   */
  materialize(input: { plan: AnnouncementPlan; expectedRevision: number; authoringRecord: AuthoringRecord; activity: AnnouncementActivity }): Promise<void>;
  /** Time-bucketed index, bounded batch; a queue delay is never the scheduling source of truth. */
  dueIntents(scope: Pick<AnnouncementScope, "tenantId" | "creatorId">, now: string, limit: number, cursor?: string): Promise<{ items: readonly AnnouncementOutboxIntent[]; nextCursor?: string }>;
  /** Conditional revision/generation/due claim, serialized against plan replacement and cancellation. */
  claimSend(scope: Pick<AnnouncementScope, "tenantId" | "creatorId">, planId: string, logicalStepId: string, expectedRevision: number, generation: number, now: string): Promise<AnnouncementDestinationStep>;
  /** Filtering and logical-row deduplication precede paging; counts use exactly the same filters.
   * Cursor binds scope, filters, ordering and projection version. Unsupported intersections fail explicitly.
   */
  list(scope: Pick<AnnouncementScope, "tenantId" | "creatorId">, filters: CollectionAnnouncementListFilters, page: { limit: number; cursor?: string }): Promise<{ items: readonly LogicalListRow[]; count: number; nextCursor?: string }>;
}
