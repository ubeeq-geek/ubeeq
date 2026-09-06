import { createHash } from "node:crypto";

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
