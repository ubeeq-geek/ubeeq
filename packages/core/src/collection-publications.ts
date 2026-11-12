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

export interface NativeDestinationOptions {
  canonicalDestination?: string;
  nativeDestinationAliases?: readonly string[];
}

export function isNativeDestination(
  destination: string,
  aliases: readonly string[] = ["native"],
): boolean {
  return destination === "native" || aliases.includes(destination);
}

/** Aggregates publications matching any configured native destination alias. */
export function aggregateNativePublications<
  T extends { destination: string; status: string },
>(publications: readonly T[], aliases: readonly string[] = ["native"]): T[] {
  return publications.filter(
    (p) => isNativeDestination(p.destination, aliases) && p.status === "live",
  );
}

/**
 * Resolves a live native publication for a work across configured native destination aliases,
 * preferring the canonical 'native' destination or falling back to the first live alias publication.
 */
export function resolveNativePublication<
  T extends { destination: string; status: string; visibility?: string },
>(publications: readonly T[], aliases: readonly string[] = ["native"]): T | undefined {
  const live = publications.filter(
    (p) =>
      isNativeDestination(p.destination, aliases) &&
      p.status === "live" &&
      (!p.visibility || ["public", "unlisted"].includes(p.visibility)),
  );
  if (live.length === 0) return undefined;
  return live.find((p) => p.destination === "native") ?? live[0];
}

/**
 * Evaluates whether a work has an eligible native publication across configured native destination aliases.
 * Avoids false ambiguity errors when a work has multiple publications across distinct aliases.
 */
export async function evaluateWorkNativePublicationEligibility<
  T extends {
    creatorId: string;
    destination: string;
    status: string;
    visibility?: string;
    providerData?: { nativeDestination?: string };
  },
>(input: {
  workId: string;
  creatorId: string;
  publications: readonly T[];
  destination: string;
  options?: NativeDestinationOptions;
  policyCheck?: () => Promise<boolean> | boolean;
  workStatus?: string;
}): Promise<NativeCollectionEligibility> {
  const aliases = input.options?.nativeDestinationAliases ?? ["native"];
  if (input.workStatus && ["archived", "deleted"].includes(input.workStatus)) {
    return {
      workId: input.workId,
      allowed: false,
      reason: "Work is unavailable for this Creator.",
    };
  }
  if (!isNativeDestination(input.destination, aliases)) {
    return {
      workId: input.workId,
      allowed: false,
      reason: "Release must be validated on this native destination.",
    };
  }
  if (input.policyCheck && !(await input.policyCheck())) {
    return {
      workId: input.workId,
      allowed: false,
      reason:
        "Destination policy or an active rights/safety hold excludes this Work.",
    };
  }
  const matching = input.publications.filter(
    (p) =>
      p.creatorId === input.creatorId && isNativeDestination(p.destination, aliases),
  );
  const live = matching.filter(
    (p) =>
      p.status === "live" &&
      (!p.visibility || ["public", "unlisted"].includes(p.visibility)) &&
      (!p.providerData?.nativeDestination ||
        isNativeDestination(p.providerData.nativeDestination, aliases)),
  );
  if (live.length === 0) {
    return {
      workId: input.workId,
      allowed: false,
      reason:
        "No released native Work Publication is available. Publish the Work separately.",
    };
  }
  return { workId: input.workId, allowed: true };
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
