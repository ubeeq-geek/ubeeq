import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalAdapterSet } from "../dist/index.js";
import { verifyRevisionedRepositoryContract } from "@ubeeq/persistence";

test("every SQLite repository port satisfies the shared persistence contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ubeeq-local-contract-"));
  try {
    const { repositories } = createLocalAdapterSet({ databasePath: join(directory, "state.sqlite"), dataDirectory: directory, publicBaseUrl: "http://127.0.0.1" });
    const names = Object.keys(repositories).filter((name) => name !== "transaction");
    for (const name of names) {
      const repository = repositories[name];
      await verifyRevisionedRepositoryContract({ repository, createRecord: (id) => ({ id, instanceId: "local", contractValue: name }), change: () => ({ contractValue: `updated-${name}` }) });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
