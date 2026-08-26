/** Product-neutral, append-only usage and credit accounting primitives. */
export interface BillingScope { instanceId: string; accountId: string; }
export type UsageUnit = "byte" | "credit" | "unit";
export interface UsageEvent {
  id: string;
  scope: BillingScope;
  idempotencyKey: string;
  category: string;
  quantity: number;
  unit: UsageUnit;
  observedAt: string;
  source: string;
  referenceId?: string;
  lotId?: string;
  linkedEventId?: string;
}
export interface CreditLot {
  id: string;
  scope: BillingScope;
  source: string;
  originalQuantity: number;
  remainingQuantity: number;
  reservedQuantity: number;
  spentQuantity: number;
  expiredQuantity: number;
  revokedQuantity: number;
  grantedAt: string;
  expiresAt: string;
  documentId?: string;
  status: "available" | "frozen" | "revoked" | "expired";
}
export interface CreditReservation {
  id: string;
  scope: BillingScope;
  quantity: number;
  state: "reserved" | "committed" | "released";
  allocations: readonly { lotId: string; quantity: number }[];
  eventId: string;
}
export interface UsageBalance {
  usageByCategory: Readonly<Record<string, number>>;
  availableCredits: number;
  reservedCredits: number;
  earliestCreditExpiry?: string;
}

const keyFor = (scope: BillingScope) => `${scope.instanceId}|${scope.accountId}`;
const clone = <T>(value: T): T => structuredClone(value);

/** In-memory reference ledger; durable adapters should preserve the same idempotency and allocation semantics transactionally. */
export class UsageCreditLedger {
  private readonly events: UsageEvent[] = [];
  private readonly lots: CreditLot[] = [];
  private readonly reservations = new Map<string, CreditReservation>();
  private readonly idempotency = new Map<string, UsageEvent>();
  private generatedId = 0;

  constructor(private readonly createId: () => string = () => `ledger-${++this.generatedId}`) {}

  appendUsage(scope: BillingScope, input: Omit<UsageEvent, "id" | "scope">): UsageEvent {
    if (!Number.isSafeInteger(input.quantity)) throw new Error("Usage quantity must be a safe integer");
    const idempotencyKey = `${keyFor(scope)}|${input.idempotencyKey}`;
    const prior = this.idempotency.get(idempotencyKey);
    if (prior) return clone(prior);
    const event: UsageEvent = Object.freeze({ ...input, id: this.createId(), scope: clone(scope) });
    this.events.push(event); this.idempotency.set(idempotencyKey, event);
    return clone(event);
  }

  grantCredits(scope: BillingScope, input: { quantity: number; source: string; grantedAt: string; expiresAt: string; idempotencyKey: string; documentId?: string }): CreditLot {
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new Error("Credit grant must be a positive integer");
    if (input.expiresAt <= input.grantedAt) throw new Error("Credit expiry must be after grant time");
    const prior = this.idempotency.get(`${keyFor(scope)}|${input.idempotencyKey}`);
    if (prior?.lotId) return clone(this.lots.find((lot) => lot.id === prior.lotId)!);
    const lot: CreditLot = { id: this.createId(), scope: clone(scope), source: input.source, originalQuantity: input.quantity, remainingQuantity: input.quantity, reservedQuantity: 0, spentQuantity: 0, expiredQuantity: 0, revokedQuantity: 0, grantedAt: input.grantedAt, expiresAt: input.expiresAt, documentId: input.documentId, status: "available" };
    this.lots.push(lot);
    this.appendUsage(scope, { idempotencyKey: input.idempotencyKey, category: "credits.granted", quantity: input.quantity, unit: "credit", observedAt: input.grantedAt, source: "billing", lotId: lot.id });
    return clone(lot);
  }

  reserveCredits(scope: BillingScope, input: { reservationId: string; quantity: number; observedAt: string; referenceId?: string }): CreditReservation {
    const reservationKey = `${keyFor(scope)}|${input.reservationId}`;
    const prior = this.reservations.get(reservationKey);
    if (prior) return clone(prior);
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new Error("Reservation must be a positive integer");
    const eligible = this.lots.filter((lot) => keyFor(lot.scope) === keyFor(scope) && lot.status === "available" && lot.expiresAt > input.observedAt && lot.remainingQuantity > lot.reservedQuantity)
      .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt) || left.grantedAt.localeCompare(right.grantedAt));
    if (eligible.reduce((sum, lot) => sum + lot.remainingQuantity - lot.reservedQuantity, 0) < input.quantity) throw new Error("INSUFFICIENT_CREDITS");
    let needed = input.quantity; const allocations: Array<{ lotId: string; quantity: number }> = [];
    for (const lot of eligible) { const quantity = Math.min(needed, lot.remainingQuantity - lot.reservedQuantity); if (!quantity) continue; lot.reservedQuantity += quantity; allocations.push({ lotId: lot.id, quantity }); needed -= quantity; if (!needed) break; }
    const event = this.appendUsage(scope, { idempotencyKey: `reserve:${input.reservationId}`, category: "credits.reserved", quantity: input.quantity, unit: "credit", observedAt: input.observedAt, source: "processing", referenceId: input.referenceId });
    const reservation: CreditReservation = { id: input.reservationId, scope: clone(scope), quantity: input.quantity, state: "reserved", allocations, eventId: event.id };
    this.reservations.set(reservationKey, reservation); return clone(reservation);
  }

  finalizeReservation(scope: BillingScope, reservationId: string, outcome: "commit" | "release", observedAt: string): CreditReservation {
    const reservation = this.reservations.get(`${keyFor(scope)}|${reservationId}`);
    if (!reservation) throw new Error("Unknown reservation");
    if (reservation.state !== "reserved") return clone(reservation);
    for (const allocation of reservation.allocations) { const lot = this.lots.find((candidate) => candidate.id === allocation.lotId)!; lot.reservedQuantity -= allocation.quantity; if (outcome === "commit") { lot.remainingQuantity -= allocation.quantity; lot.spentQuantity += allocation.quantity; } }
    reservation.state = outcome === "commit" ? "committed" : "released";
    this.appendUsage(scope, { idempotencyKey: `${outcome}:${reservationId}`, category: outcome === "commit" ? "credits.committed" : "credits.released", quantity: reservation.quantity, unit: "credit", observedAt, source: "processing", linkedEventId: reservation.eventId });
    return clone(reservation);
  }

  expireCredits(scope: BillingScope, now: string): number {
    let expired = 0;
    for (const lot of this.lots.filter((candidate) => keyFor(candidate.scope) === keyFor(scope) && candidate.status === "available" && candidate.expiresAt <= now && candidate.reservedQuantity === 0 && candidate.remainingQuantity > 0)) {
      const quantity = lot.remainingQuantity; lot.remainingQuantity = 0; lot.expiredQuantity += quantity; lot.status = "expired"; expired += quantity;
      this.appendUsage(scope, { idempotencyKey: `expire:${lot.id}`, category: "credits.expired", quantity, unit: "credit", observedAt: now, source: "expiry", lotId: lot.id });
    }
    return expired;
  }

  balance(scope: BillingScope, now = new Date().toISOString()): UsageBalance {
    const events = this.events.filter((event) => keyFor(event.scope) === keyFor(scope));
    const usageByCategory = Object.fromEntries([...new Set(events.map((event) => event.category))].map((category) => [category, events.filter((event) => event.category === category).reduce((sum, event) => sum + event.quantity, 0)]));
    const lots = this.lots.filter((lot) => keyFor(lot.scope) === keyFor(scope) && lot.status === "available" && lot.expiresAt > now);
    return { usageByCategory, availableCredits: lots.reduce((sum, lot) => sum + lot.remainingQuantity - lot.reservedQuantity, 0), reservedCredits: lots.reduce((sum, lot) => sum + lot.reservedQuantity, 0), earliestCreditExpiry: lots.filter((lot) => lot.remainingQuantity > 0).sort((left, right) => left.expiresAt.localeCompare(right.expiresAt))[0]?.expiresAt };
  }
}
