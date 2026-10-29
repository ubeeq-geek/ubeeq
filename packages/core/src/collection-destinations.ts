/** Collection organization never authorizes publication, delivery, pricing or discovery. */
export type CollectionMembershipAuthority = "platform" | "native" | "manual";
export type CollectionDestinationRole =
  "full" | "preview" | "followers" | "custom";
export interface GalleryCapabilities {
  revision: number;
  listMembership: boolean;
  completeMembership: boolean;
  addMembership: boolean;
  removeMembership: boolean;
  /** Must be verified per account, never inferred from gallery visibility. */
  membershipMayChangeAccess: boolean;
  freshnessMs: number;
}
export interface CollectionDestinationMapping {
  id: string;
  collectionId: string;
  accountId: string;
  remoteGalleryId: string;
  role: CollectionDestinationRole;
  audience: string;
  authority: CollectionMembershipAuthority;
  execution: "manual" | "automatic";
  scope: "released" | "selected";
  selections: Array<{ workId: string; publicationId?: string }>;
  reconciliation: "exact" | "custom";
  representation: string;
  removalPolicy: "review" | "propagate";
  enabled: boolean;
  generation: number;
  revision: number;
  initialReviewAt?: string;
  /** Configured native fields are individually authoritative. Empty by default. */
  fieldRules: Array<{
    field: "title" | "description" | "cover" | "order";
    authority: "platform" | "native";
  }>;
}
export interface CollectionDestinationMember {
  workId: string;
  released: boolean;
  exclusion?: string;
  publicationId?: string;
}
export interface GalleryMembershipObservation {
  id: string;
  mappingId: string;
  publicationIds: string[];
  resolvedWorks: Array<{ publicationId: string; workId?: string }>;
  complete: boolean;
  observedAt: string;
  source: "api" | "manual";
  evidence: string[];
}
export interface CollectionSyncInputs {
  membership: number;
  metadata: number;
  release: number;
  access: number;
  mapping: number;
  generation: number;
  capability: number;
}
export interface CollectionDestinationPlan {
  id: string;
  mappingId: string;
  inputs: CollectionSyncInputs;
  observationId: string;
  createdAt: string;
  expiresAt: string;
  intendedPublicationIds: string[];
  additions: string[];
  removals: string[];
  inboundAdditions: string[];
  inboundRemovals: string[];
  excluded: Array<{ workId: string; reason: string }>;
  blocked: Array<{ workId?: string; reason: string }>;
  manualSteps: string[];
  effects: Array<"membership" | "access">;
  comparison: "unknown" | "changes_pending" | "up_to_date" | "unresolved";
  verification:
    | "api_verified"
    | "manually_confirmed"
    | "stale"
    | "incomplete"
    | "unavailable";
  exact: boolean;
}
export class CollectionDestinationError extends Error {
  constructor(
    readonly code:
      | "invalid_mapping"
      | "gallery_owned"
      | "inbound_authority"
      | "field_authority"
      | "mirror_controlled"
      | "stale_plan"
      | "review_required"
      | "blocked",
    message: string,
  ) {
    super(message);
    this.name = "CollectionDestinationError";
  }
}
const fail = (
  code: CollectionDestinationError["code"],
  message: string,
): never => {
  throw new CollectionDestinationError(code, message);
};
export function validateCollectionMapping(
  mapping: CollectionDestinationMapping,
  existing: readonly CollectionDestinationMapping[],
  memberIds: readonly string[],
): void {
  if (
    !mapping.id ||
    !mapping.collectionId ||
    !mapping.accountId ||
    !mapping.remoteGalleryId ||
    !["platform", "native", "manual"].includes(mapping.authority) ||
    !["manual", "automatic"].includes(mapping.execution) ||
    !["full", "preview", "followers", "custom"].includes(mapping.role) ||
    !["released", "selected"].includes(mapping.scope) ||
    !["exact", "custom"].includes(mapping.reconciliation) ||
    !["review", "propagate"].includes(mapping.removalPolicy) ||
    !mapping.audience ||
    !mapping.representation ||
    !Number.isSafeInteger(mapping.revision) ||
    mapping.revision < 1 ||
    !Number.isSafeInteger(mapping.generation) ||
    mapping.generation < 1 ||
    typeof mapping.enabled !== "boolean"
  )
    fail("invalid_mapping", "Choose valid destination settings.");
  if (
    new Set(mapping.selections.map((s) => s.workId)).size !==
      mapping.selections.length ||
    mapping.selections.some((s) => !memberIds.includes(s.workId))
  )
    fail(
      "invalid_mapping",
      "Selected Works must be unique collection members.",
    );
  if (
    new Set(mapping.fieldRules.map((r) => r.field)).size !==
      mapping.fieldRules.length ||
    mapping.fieldRules.some(
      (r) =>
        !["title", "description", "cover", "order"].includes(r.field) ||
        !["platform", "native"].includes(r.authority),
    )
  )
    fail("invalid_mapping", "Choose one authority per native field.");
  if (!mapping.enabled) return;
  const others = existing.filter((m) => m.enabled && m.id !== mapping.id);
  if (
    others.some(
      (m) =>
        m.accountId === mapping.accountId &&
        m.remoteGalleryId === mapping.remoteGalleryId,
    )
  )
    fail(
      "gallery_owned",
      "This gallery already belongs to another mapping. Open its collection or import a detached copy.",
    );
  if (
    mapping.authority === "platform" &&
    others.some(
      (m) =>
        m.collectionId === mapping.collectionId && m.authority === "platform",
    )
  )
    fail(
      "inbound_authority",
      "Detach the existing inbound mirror or duplicate this collection as independent.",
    );
  if (
    others.some(
      (m) =>
        m.collectionId === mapping.collectionId &&
        m.fieldRules.some((rule) =>
          mapping.fieldRules.some((r) => r.field === rule.field),
        ),
    )
  )
    fail(
      "field_authority",
      "A native field already has an authority. Review its current mapping first.",
    );
}
export function assertIndependentCollectionMembership(
  collectionId: string,
  mappings: readonly CollectionDestinationMapping[],
): void {
  if (
    mappings.some(
      (m) =>
        m.collectionId === collectionId &&
        m.enabled &&
        m.authority === "platform",
    )
  )
    fail(
      "mirror_controlled",
      "Detach the inbound mirror or duplicate the collection as independent before editing membership.",
    );
}
/** Pure planning: does not fetch media, create Publications, or mutate either destination. */
export function planCollectionDestination(input: {
  id: string;
  mapping: CollectionDestinationMapping;
  inputs: CollectionSyncInputs;
  capabilities: GalleryCapabilities;
  observation: GalleryMembershipObservation;
  members: readonly CollectionDestinationMember[];
  now: string;
}): CollectionDestinationPlan {
  const { mapping: m, observation: o, capabilities: c } = input,
    now = Date.parse(input.now),
    observed = Date.parse(o.observedAt);
  if (
    o.mappingId !== m.id ||
    input.inputs.mapping !== m.revision ||
    input.inputs.generation !== m.generation ||
    input.inputs.capability !== c.revision ||
    !Number.isFinite(now) ||
    !Number.isFinite(observed) ||
    !Number.isFinite(c.freshnessMs) ||
    c.freshnessMs <= 0
  )
    fail(
      "invalid_mapping",
      "Planning inputs do not match the destination configuration.",
    );
  const fresh = observed <= now && now - observed <= c.freshnessMs;
  const complete = o.complete && c.listMembership && c.completeMembership;
  const intended = new Set<string>(),
    excluded: CollectionDestinationPlan["excluded"] = [],
    blocked: CollectionDestinationPlan["blocked"] = [];
  const selection = new Map(m.selections.map((s) => [s.workId, s]));
  if (m.scope === "selected")
    for (const s of m.selections)
      if (!input.members.some((w) => w.workId === s.workId))
        blocked.push({
          workId: s.workId,
          reason: "Selected Work is no longer a collection member.",
        });
  for (const member of m.authority === "platform" ? [] : input.members) {
    if (m.scope === "selected" && !selection.has(member.workId)) continue;
    if (!member.released) {
      excluded.push({
        workId: member.workId,
        reason: "Not released for this destination.",
      });
      continue;
    }
    if (member.exclusion) {
      excluded.push({ workId: member.workId, reason: member.exclusion });
      continue;
    }
    const publication =
      selection.get(member.workId)?.publicationId ?? member.publicationId;
    if (!publication)
      blocked.push({
        workId: member.workId,
        reason:
          "Required Publication is missing; review publication separately.",
      });
    else intended.add(publication);
  }
  const remote = new Set(o.publicationIds),
    additions = [...intended].filter((id) => !remote.has(id)),
    removals =
      m.reconciliation === "exact"
        ? [...remote].filter((id) => !intended.has(id))
        : [];
  const resolved = new Map(
    o.resolvedWorks.map((r) => [r.publicationId, r.workId]),
  );
  if (m.authority === "platform")
    for (const id of remote)
      if (!resolved.get(id))
        blocked.push({ reason: `Unresolved remote Publication: ${id}` });
  const sourceWorks = [
    ...new Set(
      [...remote]
        .map((id) => resolved.get(id))
        .filter((id): id is string => !!id),
    ),
  ];
  const nativeWorks = new Set(input.members.map((w) => w.workId));
  const inboundAdditions =
    m.authority === "platform"
      ? sourceWorks.filter((id) => !nativeWorks.has(id))
      : [];
  // Never infer a source removal from incomplete or unresolved identities.
  const inboundRemovals =
    m.authority === "platform" && complete && fresh && !blocked.length
      ? [...nativeWorks].filter((id) => !sourceWorks.includes(id))
      : [];
  const manualSteps: string[] = [];
  if (!complete)
    manualSteps.push(
      "Complete or restricted membership cannot be verified; removals are blocked.",
    );
  if (!fresh) manualSteps.push("Refresh membership before applying this plan.");
  if (m.authority === "manual")
    manualSteps.push(
      "Complete changes on the platform and confirm the specific actions.",
    );
  if (
    m.authority === "native" &&
    ((additions.length && !c.addMembership) ||
      (removals.length && !c.removeMembership))
  )
    manualSteps.push(
      "Membership writes are unavailable; complete changes on the platform.",
    );
  if (
    m.removalPolicy === "review" &&
    (removals.length || inboundRemovals.length)
  )
    manualSteps.push("Review membership removals.");
  const differences =
    m.authority === "platform"
      ? inboundAdditions.length + inboundRemovals.length
      : additions.length + removals.length;
  const exact =
    m.reconciliation === "exact" &&
    complete &&
    fresh &&
    !blocked.length &&
    differences === 0 &&
    o.source === "api";
  const verification = !c.listMembership
    ? "unavailable"
    : !fresh
      ? "stale"
      : !complete
        ? "incomplete"
        : o.source === "manual"
          ? "manually_confirmed"
          : "api_verified";
  return {
    id: input.id,
    mappingId: m.id,
    inputs: { ...input.inputs },
    observationId: o.id,
    createdAt: input.now,
    expiresAt: new Date(observed + c.freshnessMs).toISOString(),
    intendedPublicationIds: [...intended],
    additions: m.authority !== "platform" ? additions : [],
    removals: m.authority !== "platform" && complete && fresh ? removals : [],
    inboundAdditions,
    inboundRemovals,
    excluded,
    blocked,
    manualSteps,
    effects: c.membershipMayChangeAccess
      ? ["membership", "access"]
      : ["membership"],
    comparison: blocked.length
      ? "unresolved"
      : !complete || !fresh
        ? "unknown"
        : differences
          ? "changes_pending"
          : "up_to_date",
    verification,
    exact,
  };
}
export function assertCurrentCollectionPlan(
  plan: CollectionDestinationPlan,
  mapping: CollectionDestinationMapping,
  current: CollectionSyncInputs,
  now: string,
): void {
  if (
    !mapping.enabled ||
    plan.mappingId !== mapping.id ||
    current.mapping !== mapping.revision ||
    current.generation !== mapping.generation ||
    (Object.keys(plan.inputs) as Array<keyof CollectionSyncInputs>).some(
      (k) => plan.inputs[k] !== current[k],
    ) ||
    !Number.isFinite(Date.parse(now)) ||
    Date.parse(plan.expiresAt) < Date.parse(now)
  )
    fail(
      "stale_plan",
      "This plan is stale. Review a fresh comparison before applying.",
    );
}
export function authorizeCollectionPlan(
  plan: CollectionDestinationPlan,
  mapping: CollectionDestinationMapping,
  reviewed: boolean,
): void {
  if (plan.blocked.length || plan.verification !== "api_verified")
    fail(
      "blocked",
      "Resolve blockers and obtain a fresh complete observation before applying.",
    );
  if (mapping.authority === "manual")
    fail("blocked", "This association is managed manually.");
  if (
    !reviewed &&
    (!mapping.initialReviewAt ||
      mapping.execution !== "automatic" ||
      plan.effects.includes("access") ||
      (mapping.removalPolicy === "review" &&
        (plan.removals.length || plan.inboundRemovals.length)))
  )
    fail(
      "review_required",
      "Review this destination plan before applying changes.",
    );
}

export interface CollectionSyncOperationReceipt {
  key: string;
  kind: "add" | "remove";
  publicationId: string;
  state: "prepared" | "confirmed" | "failed" | "uncertain";
  remoteReceipt?: string;
}
export interface CollectionSyncExecution {
  id: string;
  planId: string;
  mappingId: string;
  state:
    | "queued"
    | "running"
    | "partially_applied"
    | "failed"
    | "paused"
    | "verified"
    | "unverified";
  operations: CollectionSyncOperationReceipt[];
  startedAt?: string;
  completedAt?: string;
  readbackObservationId?: string;
}
/** Storage owns durable receipts and leases; adapters own credential and permission checks. */
export interface CollectionSyncExecutionPort {
  /** Serialize on BOTH mapping and account/gallery identity, including lease fencing. */
  exclusive<T>(
    mapping: CollectionDestinationMapping,
    operation: () => Promise<T>,
  ): Promise<T>;
  /** Throw stale_plan if either the mapping or account/gallery lease was lost. */
  assertLease(mapping: CollectionDestinationMapping): Promise<void>;
  current(mappingId: string): Promise<{
    mapping: CollectionDestinationMapping;
    inputs: CollectionSyncInputs;
    archived: boolean;
    connected: boolean;
    capabilities: GalleryCapabilities;
  }>;
  getExecution(planId: string): Promise<CollectionSyncExecution | undefined>;
  saveExecution(run: CollectionSyncExecution): Promise<void>;
  /** Required publication validator. Membership writes can change delivery/access. */
  validateEffects(
    plan: CollectionDestinationPlan,
    reviewed: boolean,
  ): Promise<void>;
  /** Must reconcile an existing prepared/uncertain key before any repeat provider call. */
  reconcileOperation(
    mapping: CollectionDestinationMapping,
    operation: CollectionSyncOperationReceipt,
  ): Promise<"confirmed" | "not_applied" | "unknown">;
  writeMembership(
    mapping: CollectionDestinationMapping,
    operation: CollectionSyncOperationReceipt,
    /** Invoke after adapter preparation, immediately before issuing the provider request.
     * Adapters must also fence their durable writes with the owned lease token.
     */
    assertCurrent: () => Promise<void>,
  ): Promise<{ receipt?: string }>;
  observe(
    mapping: CollectionDestinationMapping,
  ): Promise<GalleryMembershipObservation | undefined>;
}
/** Outbound executor. It never creates or deletes Works, Publications, or commercial configuration. */
export async function executeCollectionDestinationPlan(input: {
  plan: CollectionDestinationPlan;
  mapping: CollectionDestinationMapping;
  reviewed: boolean;
  port: CollectionSyncExecutionPort;
  now: () => string;
}): Promise<CollectionSyncExecution> {
  const { port, plan } = input;
  return port.exclusive(input.mapping, async () => {
    const check = async () => {
      const current = await port.current(plan.mappingId);
      assertCurrentCollectionPlan(
        plan,
        current.mapping,
        current.inputs,
        input.now(),
      );
      if (current.archived || !current.connected)
        fail("stale_plan", "Collection or connection is paused.");
      if (current.mapping.authority !== "native")
        fail(
          "blocked",
          "Only an outbound native authority can execute remote membership writes.",
        );
      if (
        (plan.additions.length && !current.capabilities.addMembership) ||
        (plan.removals.length && !current.capabilities.removeMembership)
      )
        fail(
          "blocked",
          "Manual action required for unsupported membership operations.",
        );
      authorizeCollectionPlan(plan, current.mapping, input.reviewed);
      await port.validateEffects(plan, input.reviewed);
      await port.assertLease(current.mapping);
      return current.mapping;
    };
    let mapping = await check();
    const saved = await port.getExecution(plan.id);
    if (saved?.state === "verified") return saved;
    const run: CollectionSyncExecution = saved ?? {
      id: plan.id,
      mappingId: mapping.id,
      planId: plan.id,
      state: "queued",
      operations: [
        ...plan.additions.map((publicationId) => ({
          kind: "add" as const,
          publicationId,
        })),
        ...plan.removals.map((publicationId) => ({
          kind: "remove" as const,
          publicationId,
        })),
      ].map((o) => ({
        ...o,
        key: JSON.stringify([
          mapping.id,
          mapping.generation,
          plan.id,
          o.kind,
          o.publicationId,
        ]),
        state: "prepared" as const,
      })),
    };
    run.state = "running";
    run.startedAt ??= input.now();
    await port.saveExecution(structuredClone(run));
    for (const operation of run.operations) {
      if (operation.state === "confirmed") continue;
      try {
        mapping = await check(); // Recheck immediately before EVERY remote write.
        const result = await port.reconcileOperation(mapping, operation);
        if (result === "confirmed") {
          operation.state = "confirmed";
          await port.saveExecution(structuredClone(run));
          continue;
        }
        if (result === "unknown") {
          operation.state = "uncertain";
          run.state = "partially_applied";
          await port.saveExecution(structuredClone(run));
          return run;
        }
        operation.state = "prepared";
        await port.saveExecution(structuredClone(run));
        // Reconciliation and durable receipt writes may outlive the reviewed
        // inputs or lease. Never carry their earlier authorization into a write.
        mapping = await check();
        // A timeout or a local receipt failure must be reconciled, never blindly repeated.
        const receipt = await port.writeMembership(
          mapping,
          structuredClone(operation),
          async () => { await check(); },
        );
        operation.remoteReceipt = receipt.receipt;
        operation.state = "confirmed";
        await port.saveExecution(structuredClone(run));
      } catch (error) {
        operation.state = "uncertain";
        run.state =
          error instanceof CollectionDestinationError &&
          error.code === "stale_plan"
            ? "paused"
            : "partially_applied";
        await port.saveExecution(structuredClone(run));
        return run;
      }
    }
    // Verification is evidence-based, not implied by accepted operations.
    const observation = await port.observe(mapping);
    const intended = new Set(plan.intendedPublicationIds),
      remote = new Set(observation?.publicationIds ?? []);
    const current = await port.current(mapping.id),
      observedAt = Date.parse(observation?.observedAt ?? ""),
      now = Date.parse(input.now());
    let currentPlan = true;
    try {
      assertCurrentCollectionPlan(
        plan,
        current.mapping,
        current.inputs,
        input.now(),
      );
    } catch {
      currentPlan = false;
    }
    run.readbackObservationId = observation?.id;
    const equal =
      current.mapping.reconciliation === "exact"
        ? remote.size === intended.size &&
          [...intended].every((id) => remote.has(id))
        : [...intended].every((id) => remote.has(id));
    run.state =
      currentPlan &&
      !current.archived &&
      current.connected &&
      observation?.mappingId === mapping.id &&
      observation.source === "api" &&
      observation.complete &&
      current.capabilities.completeMembership &&
      observedAt <= now &&
      now - observedAt <= current.capabilities.freshnessMs &&
      equal
        ? "verified"
        : "unverified";
    run.completedAt = input.now();
    await port.saveExecution(structuredClone(run));
    return run;
  });
}
