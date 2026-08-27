import assert from "node:assert/strict";
import test from "node:test";
import { validateDeploymentArtifactManifest, validateRegionalDeploymentPlan } from "../dist/index.js";

test("validates neutral artifact provenance and regional rollout contracts", () => {
  assert.equal(validateDeploymentArtifactManifest({ schemaVersion: 1, product: "example", revision: "a".repeat(40), artifacts: { api: { path: "api", fileCount: 1, sha256: "b".repeat(64) } } }, { product: "example", revision: "a".repeat(40), artifacts: ["api"] }).product, "example");
  assert.equal(validateRegionalDeploymentPlan({ regions: ["us-east-2", "eu-central-1"], artifactRegistryStackName: "ArtifactRegistry" }).regions.length, 2);
});
