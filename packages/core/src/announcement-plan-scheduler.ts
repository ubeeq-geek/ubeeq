import { announcementInstant, AnnouncementOrchestrationError } from "./announcement-orchestration.js";
import type { AnnouncementHold } from "./announcement-orchestration.js";

export interface AnnouncementLatePolicy {
  mode: "hold" | "send_when_ready";
  /** null explicitly removes the limit; durations are elapsed milliseconds. */
  maximumLatenessMs: number | null;
}
export const DEFAULT_ANNOUNCEMENT_LATE_POLICY: Readonly<AnnouncementLatePolicy> = Object.freeze({ mode: "hold", maximumLatenessMs: 24 * 60 * 60 * 1000 });
export interface AnnouncementCivilTime {
  timeZone: string;
  localDateTime: string;
  offsetMinutes: number;
  instant: string;
}
export type AnnouncementTiming =
  | { mode: "after_publication"; timeZone: string }
  | { mode: "delay_after_publication"; timeZone: string; durationMs: number }
  | { mode: "at_time"; civilTime: AnnouncementCivilTime };
export type AnnouncementFollowUpAnchor =
  | { mode: "corresponding_destination" }
  | { mode: "first_successful_initial_delivery" }
  | { mode: "parent_destination"; destinationKey: string };
export type AnnouncementFollowUpTiming =
  | { mode: "delay_after_parent"; timeZone: string; durationMs: number; anchor: AnnouncementFollowUpAnchor }
  | { mode: "at_time"; civilTime: AnnouncementCivilTime; anchor: AnnouncementFollowUpAnchor };
export interface AnnouncementParentDelivery {
  destinationKey: string;
  outcome: "published" | "draft" | "pending" | "failed" | "cancelled" | "unknown";
  sentAt?: string;
}
export interface AnnouncementScheduleEvaluation {
  state: "waiting_publication" | "waiting_parent" | "scheduled" | "due" | "held" | "cancelled";
  requestedAt?: string;
  dueAt?: string;
  anchorAt?: string;
  holds: AnnouncementHold[];
}
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    if (!timeZone?.trim() || /^[+-]/.test(timeZone)) throw new Error();
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  } catch { throw new AnnouncementOrchestrationError("INVALID_INPUT", "Choose a valid IANA scheduling time zone."); }
}
function localEpoch(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value))
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "Enter a local date and time including seconds.");
  const epoch = Date.parse(`${value}Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 19) !== value)
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "Enter a valid local date and time.");
  return epoch;
}
function formattedEpoch(format: Intl.DateTimeFormat, epoch: number): number {
  const p = Object.fromEntries(format.formatToParts(epoch).map(part => [part.type, part.value]));
  return localEpoch(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`);
}
/** Resolve gaps and folds explicitly, including half-hour transitions and fractional-offset zones. */
export function resolveAnnouncementCivilTime(input: {
  timeZone: string;
  localDateTime: string;
  occurrence?: "earlier" | "later";
  offsetMinutes?: number;
}): AnnouncementCivilTime {
  const local = localEpoch(input.localDateTime), format = zoneFormatter(input.timeZone);
  const offsets = new Set<number>();
  for (let hour = -48; hour <= 48; hour += 3) {
    const sample = local + hour * 3600000;
    offsets.add((formattedEpoch(format, sample) - sample) / 60000);
  }
  const candidates = [...offsets].map(offset => ({ offset, epoch: local - offset * 60000 }))
    .filter(c => formattedEpoch(format, c.epoch) === local).sort((a, b) => a.epoch - b.epoch);
  if (!candidates.length) throw new AnnouncementOrchestrationError("INVALID_INPUT", "This local time does not exist because the clock moves forward. Choose another time.");
  if (input.occurrence !== undefined && !["earlier", "later"].includes(input.occurrence))
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "Choose the earlier or later occurrence.");
  if (candidates.length > 1 && input.occurrence === undefined && input.offsetMinutes === undefined)
    throw new AnnouncementOrchestrationError("REVIEW_REQUIRED", "This local time occurs twice. Choose the earlier or later occurrence.");
  const selected = input.occurrence === "later" ? candidates[candidates.length - 1] : input.occurrence === "earlier" ? candidates[0]
    : input.offsetMinutes !== undefined ? candidates.find(c => c.offset === input.offsetMinutes) : candidates[0];
  if (!selected || (input.offsetMinutes !== undefined && selected.offset !== input.offsetMinutes))
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "The chosen UTC offset does not match this local time and zone.");
  return { timeZone: input.timeZone, localDateTime: input.localDateTime, offsetMinutes: selected.offset, instant: new Date(selected.epoch).toISOString() };
}
export function validateAnnouncementTiming(timing: AnnouncementTiming | AnnouncementFollowUpTiming): void {
  if (timing.mode === "at_time") {
    const c = timing.civilTime;
    const resolved = resolveAnnouncementCivilTime(c);
    if (announcementInstant(resolved.instant) !== announcementInstant(c.instant))
      throw new AnnouncementOrchestrationError("INVALID_INPUT", "The saved instant does not match the chosen local time and offset.");
  } else if (["after_publication", "delay_after_publication", "delay_after_parent"].includes(timing.mode)) {
    zoneFormatter(timing.timeZone);
    if (timing.mode !== "after_publication" && (!Number.isSafeInteger(timing.durationMs) || timing.durationMs < 0))
      throw new AnnouncementOrchestrationError("INVALID_INPUT", "Use a nonnegative elapsed duration; one day is 24 hours.");
  } else throw new AnnouncementOrchestrationError("INVALID_INPUT", "Choose a supported timing mode.");
}
export function validateAnnouncementLatePolicy(policy: AnnouncementLatePolicy): void {
  if (!policy || !["hold", "send_when_ready"].includes(policy.mode) || (policy.maximumLatenessMs !== null && (!Number.isSafeInteger(policy.maximumLatenessMs) || policy.maximumLatenessMs < 0)))
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "Choose a late policy and a nonnegative maximum lateness, or explicitly remove the limit.");
}
function evaluateDue(dueAt: string, input: { now: string; dependencyReadyAt: string; absolute: boolean; latePolicy: AnnouncementLatePolicy }, anchorAt?: string): AnnouncementScheduleEvaluation {
  validateAnnouncementLatePolicy(input.latePolicy);
  const now = announcementInstant(input.now), due = announcementInstant(dueAt), ready = announcementInstant(input.dependencyReadyAt);
  const elapsed = now - due;
  // 'hold' applies to a missed absolute dependency. The maximum window also bounds scheduler outages.
  if ((input.absolute && ready > due && input.latePolicy.mode === "hold") || (input.latePolicy.maximumLatenessMs !== null && elapsed > input.latePolicy.maximumLatenessMs))
    return { state: "held", dueAt, anchorAt, holds: [{ code: "SCHEDULE_EXPIRED", message: "The saved delivery time or maximum lateness has passed. Review a new time before sending." }] };
  return { state: now < due ? "scheduled" : "due", dueAt, anchorAt, holds: [] };
}
export function evaluateAnnouncementSchedule(input: {
  timing: AnnouncementTiming;
  latePolicy: AnnouncementLatePolicy;
  releaseReadyAt?: string;
  now: string;
}): AnnouncementScheduleEvaluation {
  validateAnnouncementTiming(input.timing); validateAnnouncementLatePolicy(input.latePolicy);
  const now = announcementInstant(input.now);
  const requestedAt = input.timing.mode === "at_time" ? input.timing.civilTime.instant : undefined;
  if (!input.releaseReadyAt || announcementInstant(input.releaseReadyAt) > now)
    return { state: "waiting_publication", requestedAt, holds: [] };
  const ready = announcementInstant(input.releaseReadyAt);
  const dueAt = requestedAt ?? new Date(ready + (input.timing.mode === "delay_after_publication" ? input.timing.durationMs : 0)).toISOString();
  return { ...evaluateDue(dueAt, { ...input, dependencyReadyAt: input.releaseReadyAt, absolute: input.timing.mode === "at_time" }, input.releaseReadyAt), requestedAt };
}
export function evaluateAnnouncementFollowUpSchedule(input: {
  timing: AnnouncementFollowUpTiming;
  latePolicy: AnnouncementLatePolicy;
  destinationKey: string;
  parentDestinationKeys: readonly string[];
  parentDeliveries: readonly AnnouncementParentDelivery[];
  /** Retain the persisted successful anchor through later initial edits or rescheduling. */
  fixedAnchorAt?: string;
  now: string;
}): AnnouncementScheduleEvaluation {
  validateAnnouncementTiming(input.timing); validateAnnouncementLatePolicy(input.latePolicy);
  const now = announcementInstant(input.now), anchor = input.timing.anchor;
  const requestedAt = input.timing.mode === "at_time" ? input.timing.civilTime.instant : undefined;
  const key = anchor.mode === "corresponding_destination" ? input.destinationKey : anchor.mode === "parent_destination" ? anchor.destinationKey : undefined;
  if (!["corresponding_destination", "parent_destination", "first_successful_initial_delivery"].includes(anchor.mode) || (key !== undefined && !input.parentDestinationKeys.includes(key)))
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "Choose an explicit existing parent destination or first successful initial delivery for this follow-up destination.");
  const deliveries = input.parentDeliveries.filter(d => input.parentDestinationKeys.includes(d.destinationKey) && (key === undefined || d.destinationKey === key));
  if (new Set(deliveries.map(d => d.destinationKey)).size !== deliveries.length)
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "Resolve each parent destination to one authoritative delivery outcome.");
  const successes = deliveries.filter(d => d.outcome === "published" && d.sentAt && announcementInstant(d.sentAt) <= now).map(d => d.sentAt!);
  const anchorAt = input.fixedAnchorAt ?? successes.sort((a, b) => announcementInstant(a) - announcementInstant(b))[0];
  if (!anchorAt) {
    if ((key !== undefined && deliveries.some(d => d.outcome === "cancelled")) || (input.parentDestinationKeys.length > 0 && input.parentDestinationKeys.every(k => deliveries.some(d => d.destinationKey === k && d.outcome === "cancelled"))))
      return { state: "cancelled", requestedAt, holds: [] };
    return { state: "waiting_parent", requestedAt, holds: [{ code: "PARENT_NOT_SENT", destinationKey: key, message: "Wait for confirmed published initial delivery. Review or retry its failed destination if needed." }] };
  }
  if (announcementInstant(anchorAt) > now) throw new AnnouncementOrchestrationError("INVALID_INPUT", "A successful parent anchor cannot be in the future.");
  const dueAt = input.timing.mode === "at_time" ? input.timing.civilTime.instant : new Date(announcementInstant(anchorAt) + input.timing.durationMs).toISOString();
  return { ...evaluateDue(dueAt, { ...input, dependencyReadyAt: anchorAt, absolute: input.timing.mode === "at_time" }, anchorAt), requestedAt };
}
