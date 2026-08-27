import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalAdapterSet } from "../dist/index.js";
import { verifyRevisionedRepositoryContract } from "@ubeeq/persistence";

test("SQLite creator repository satisfies the shared persistence contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-local-contract-"));
  try {
    const { repositories } = createLocalAdapterSet({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1" });
    await verifyRevisionedRepositoryContract({ repository: repositories.creators, createRecord: (id) => ({ id, instanceId: "local", handle: "creator", displayName: "Creator" }), change: () => ({ displayName: "Updated" }) });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
