/** Native collection presentation is independent from editorial state and external mappings. */
export interface NativeCollectionPublication {
  collectionId: string;
  destination: string;
  revision: number;
  release: "draft" | "scheduled" | "published" | "unpublished";
  audience: string;
  scope: "released" | "selected";
  selectedWorkIds: string[];
  /** Explicit release snapshot. New members never inherit destination release. */
  releasedWorkIds: string[];
  offerId?: string;
  scheduledAt?: string;
  updatedAt: string;
  publishedAt?: string;
  excluded: Array<{ workId: string; reason: string }>;
  includedWorkIds: string[];
}
export interface NativeCollectionEligibility {
  workId: string;
  allowed: boolean;
  reason?: string;
}
export class NativeCollectionPublicationError extends Error {
  readonly code = "invalid_collection_publication";
}
export function nativeCollectionIsReleased(
  publication: NativeCollectionPublication,
  now: string,
): boolean {
  if (!Number.isFinite(Date.parse(now))) return false;
  return (
    publication.release === "published" ||
    (publication.release === "scheduled" &&
      Number.isFinite(Date.parse(publication.scheduledAt ?? "")) &&
      Date.parse(publication.scheduledAt!) <= Date.parse(now))
  );
}
/** No entitlement or media delivery decisions are made by this function. */
export function planNativeCollectionPublication(input: {
  publication: NativeCollectionPublication;
  memberIds: readonly string[];
  eligibility: readonly NativeCollectionEligibility[];
  now: string;
}): NativeCollectionPublication {
  const { publication: p, memberIds, eligibility } = input;
  const validIds = (ids: readonly string[]) =>
    new Set(ids).size === ids.length &&
    ids.every((id) => memberIds.includes(id));
  if (
    !p.collectionId ||
    !p.destination ||
    !p.audience ||
    !Number.isSafeInteger(p.revision) ||
    p.revision < 1 ||
    !["draft", "scheduled", "published", "unpublished"].includes(p.release) ||
    !["released", "selected"].includes(p.scope) ||
    new Set(memberIds).size !== memberIds.length ||
    !validIds(p.selectedWorkIds) ||
    !validIds(p.releasedWorkIds) ||
    !Number.isFinite(Date.parse(input.now)) ||
    (p.release === "scheduled" &&
      (!Number.isFinite(Date.parse(p.scheduledAt ?? "")) ||
        Date.parse(p.scheduledAt!) <= Date.parse(input.now)))
  ) {
    throw new NativeCollectionPublicationError(
      "Choose valid release, scope, schedule and collection members.",
    );
  }
  const decisions = new Map(eligibility.map((item) => [item.workId, item]));
  const selected = new Set(p.selectedWorkIds),
    released = new Set(p.releasedWorkIds),
    includedWorkIds: string[] = [],
    excluded: NativeCollectionPublication["excluded"] = [];
  for (const workId of memberIds) {
    if (p.scope === "selected" && !selected.has(workId)) continue;
    if (!released.has(workId)) {
      excluded.push({ workId, reason: "Not released for this destination." });
      continue;
    }
    const decision = decisions.get(workId);
    if (!decision?.allowed) {
      excluded.push({
        workId,
        reason:
          decision?.reason ??
          "Destination eligibility has not been established.",
      });
      continue;
    }
    includedWorkIds.push(workId);
  }
  return {
    ...p,
    selectedWorkIds: [...p.selectedWorkIds],
    releasedWorkIds: [...p.releasedWorkIds],
    includedWorkIds,
    excluded,
    updatedAt: input.now,
    publishedAt:
      p.release === "published" ? (p.publishedAt ?? input.now) : p.publishedAt,
  };
}
