import { createHash } from "node:crypto";
import { announcementInstant, assertAnnouncementId } from "@ubeeq/core";

export type AnnouncementPublicationStatus = "queued" | "sending" | "sent" | "retry_scheduled" | "failed" | "cancelled";

/** Products supply snapshot fields and providers; this contract never sends content. */
export interface AnnouncementPublication<C extends object = Record<string, unknown>, P extends string = string> {
  announcementPublicationId: string;
  provider: P;
  connectionId: string;
  targetId: string;
  workId?: string;
  idempotencyKey: string;
  content: C;
  status: AnnouncementPublicationStatus;
  remoteId?: string;
  remoteUri?: string;
}

/** Explicit alias at boundaries that also deal with a product's authoring record. */
export type AnnouncementDeliverySnapshot<C extends object = Record<string, unknown>, P extends string = string> = AnnouncementPublication<C, P>;

export interface AnnouncementDeliveryOrchestration {
  schemaVersion: 1;
  planId: string;
  logicalDestinationStepId: string;
  generation: number;
  contentRevision: string;
  dueAt: string;
  supersedesDeliveryId?: string;
}
/** Opt-in extension only. Legacy queued snapshots and their identity hashes are unchanged. */
export type PlannedAnnouncementDeliverySnapshot<C extends object = Record<string, unknown>, P extends string = string> = AnnouncementDeliverySnapshot<C, P> & { orchestration: AnnouncementDeliveryOrchestration };

export function createPlannedAnnouncementDeliverySnapshot<C extends object, P extends string>(
  input: Omit<AnnouncementPublication<C, P>, "announcementPublicationId" | "status"> & { orchestration: AnnouncementDeliveryOrchestration },
): PlannedAnnouncementDeliverySnapshot<C, P> {
  const { orchestration, ...delivery } = input;
  if (!delivery.idempotencyKey.trim()) throw new Error("An announcement publication requires an idempotency key.");
  [orchestration.planId, orchestration.logicalDestinationStepId, orchestration.contentRevision].forEach(assertAnnouncementId);
  announcementInstant(orchestration.dueAt);
  if (orchestration.supersedesDeliveryId !== undefined) assertAnnouncementId(orchestration.supersedesDeliveryId);
  if (orchestration.schemaVersion !== 1 || !Number.isSafeInteger(orchestration.generation) || orchestration.generation < 1)
    throw new Error("A planned announcement delivery requires a valid schema and generation.");
  // Replacements must never collide with a prior generation, even when the host reuses its operation key.
  const idempotencyKey = JSON.stringify([delivery.idempotencyKey, orchestration.planId, orchestration.logicalDestinationStepId, orchestration.generation]);
  return { ...createAnnouncementPublication({ ...delivery, idempotencyKey }), orchestration: structuredClone(orchestration) };
}

export function assertPlannedAnnouncementDeliveryImmutable(previous: PlannedAnnouncementDeliverySnapshot<object>, next: PlannedAnnouncementDeliverySnapshot<object>): void {
  assertAnnouncementPublicationImmutable(previous, next);
  if (JSON.stringify(previous.orchestration) !== JSON.stringify(next.orchestration))
    throw new Error("Queued announcement orchestration is immutable; create a replacement generation.");
}

export const createAnnouncementPublication = <C extends object, P extends string>(
  input: Omit<AnnouncementPublication<C, P>, "announcementPublicationId" | "status">
): AnnouncementPublication<C, P> => {
  if (!input.idempotencyKey.trim()) throw new Error("An announcement publication requires an idempotency key.");
  // Preserve existing tuple serialization so persisted publication IDs remain valid.
  const announcementPublicationId = createHash("sha256")
    .update(JSON.stringify([input.provider, input.connectionId, input.targetId, input.idempotencyKey]))
    .digest("hex");
  return { ...input, content: structuredClone(input.content), announcementPublicationId, status: "queued" };
};

/** Call before committing replacement state; atomic persistence is adapter-owned. */
export const assertAnnouncementPublicationImmutable = (
  previous: AnnouncementPublication<object>,
  next: AnnouncementPublication<object>
): void => {
  if (previous.announcementPublicationId !== next.announcementPublicationId
    || previous.idempotencyKey !== next.idempotencyKey
    || previous.provider !== next.provider
    || previous.connectionId !== next.connectionId
    || previous.targetId !== next.targetId
    || previous.workId !== next.workId
    || JSON.stringify(previous.content) !== JSON.stringify(next.content)) {
    throw new Error("Queued announcement publication content and destination are immutable.");
  }
};
