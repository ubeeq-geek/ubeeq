import assert from "node:assert/strict";
import test from "node:test";
import { OptimisticConcurrencyError, verifyRevisionedRepositoryContract } from "../dist/index.js";

const records = new Map();
const repository = {
  async create(record, options) {
    const existing = records.get(record.id);
    if (existing && options?.idempotencyKey === existing.createKey) return existing.value;
    const value = { ...record, revision: 1, createdAt: "now", updatedAt: "now" };
    records.set(record.id, { value, createKey: options?.idempotencyKey });
    return value;
  },
  async get(id) { return records.get(id)?.value; },
  async list() { return { items: [...records.values()].map(({ value }) => value) }; },
  async update(id, revision, change) {
    const current = records.get(id)?.value;
    if (!current || current.revision !== revision) throw new OptimisticConcurrencyError(id, revision);
    const value = { ...current, ...change, revision: revision + 1, updatedAt: "later" };
    records.set(id, { value });
    return value;
  },
  async remove(id, revision) {
    const current = records.get(id)?.value;
    if (!current || current.revision !== revision) throw new OptimisticConcurrencyError(id, revision);
    records.delete(id);
  }
};

test("shared repository contract fixture detects required revision behavior", async () => {
  await verifyRevisionedRepositoryContract({
    repository,
    createRecord: (id) => ({ id, instanceId: "instance", handle: "creator", displayName: "Creator" }),
    change: () => ({ displayName: "Updated creator" })
  });
  assert.equal(records.size, 0);
});
