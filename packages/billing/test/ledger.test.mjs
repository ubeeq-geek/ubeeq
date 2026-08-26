import assert from "node:assert/strict";
import test from "node:test";
import { UsageCreditLedger } from "../dist/index.js";

const scope = { instanceId: "instance", accountId: "account" };
const at = "2026-08-25T12:00:00.000Z";

test("allocates earliest-expiring credits and preserves idempotency", () => {
  let sequence = 0;
  const ledger = new UsageCreditLedger(() => `id-${++sequence}`);
  ledger.grantCredits(scope, { quantity: 10, source: "free", grantedAt: at, expiresAt: "2026-09-01T00:00:00.000Z", idempotencyKey: "free" });
  ledger.grantCredits(scope, { quantity: 30, source: "paid", grantedAt: at, expiresAt: "2027-08-25T00:00:00.000Z", idempotencyKey: "paid" });
  const first = ledger.reserveCredits(scope, { reservationId: "job", quantity: 25, observedAt: at });
  assert.deepEqual(ledger.reserveCredits(scope, { reservationId: "job", quantity: 25, observedAt: at }), first);
  assert.deepEqual(first.allocations.map((allocation) => allocation.quantity), [10, 15]);
  ledger.finalizeReservation(scope, "job", "commit", at);
  assert.deepEqual(ledger.balance(scope, at), { usageByCategory: { "credits.granted": 40, "credits.reserved": 25, "credits.committed": 25 }, availableCredits: 15, reservedCredits: 0, earliestCreditExpiry: "2027-08-25T00:00:00.000Z" });
});

test("does not expire reserved credits and keeps scopes isolated", () => {
  const ledger = new UsageCreditLedger();
  ledger.grantCredits(scope, { quantity: 5, source: "promotion", grantedAt: at, expiresAt: "2026-09-01T00:00:00.000Z", idempotencyKey: "grant" });
  ledger.reserveCredits(scope, { reservationId: "held", quantity: 1, observedAt: at });
  assert.equal(ledger.expireCredits(scope, "2026-09-02T00:00:00.000Z"), 0);
  assert.equal(ledger.balance({ ...scope, accountId: "other" }, at).availableCredits, 0);
});
