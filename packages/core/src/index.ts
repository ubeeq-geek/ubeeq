/** Stable, product-neutral domain identifiers. */
export type EntityId = string & { readonly __entityId: unique symbol };

export interface AuditEvent {
  id: EntityId;
  occurredAt: string;
  actorId?: EntityId;
  type: string;
  subjectId: EntityId;
  metadata?: Record<string, unknown>;
}

export interface UsageRecord {
  id: EntityId;
  accountId: EntityId;
  meter: string;
  quantity: number;
  recordedAt: string;
  source: string;
}

