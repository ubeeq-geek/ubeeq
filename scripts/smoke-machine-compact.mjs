import { spawnSync } from "node:child_process";

const composeDirectory = new URL("../examples/machine/compact/", import.meta.url).pathname;
const environment = {
  ...process.env,
  UBEEQ_PUBLIC_HOST: process.env.UBEEQ_PUBLIC_HOST ?? "localhost",
  UBEEQ_INSTANCE_ID: process.env.UBEEQ_INSTANCE_ID ?? "compact-smoke",
  UBEEQ_CELL_ID: process.env.UBEEQ_CELL_ID ?? "compact-smoke-cell",
  UBEEQ_CELL_REGION: process.env.UBEEQ_CELL_REGION ?? "local",
  UBEEQ_CELL_OPERATOR: process.env.UBEEQ_CELL_OPERATOR ?? "Smoke test",
  UBEEQ_CREDENTIAL_ENCRYPTION_KEY: process.env.UBEEQ_CREDENTIAL_ENCRYPTION_KEY ?? "compact-smoke-secret-not-for-production",
};
const compose = (arguments_) => spawnSync("docker", ["compose", ...arguments_], { cwd: composeDirectory, env: environment, encoding: "utf8" });
const result = compose(["config", "--quiet"]);
if (result.error?.code === "ENOENT") {
  console.log("Skipping compact machine Docker smoke test because Docker is unavailable.");
  process.exit(0);
}
if (result.status !== 0) throw new Error(result.stderr || "Compact machine Compose configuration is invalid.");
console.log("Compact machine Compose configuration is valid. Set RUN_MACHINE_COMPACT_SMOKE=1 to build, start, and probe the deployment.");

if (process.env.RUN_MACHINE_COMPACT_SMOKE !== "1") process.exit(0);
try {
  const started = compose(["up", "--build", "--detach", "--wait"]);
  if (started.status !== 0) throw new Error(started.stderr || "Compact machine deployment did not become healthy.");
  const health = spawnSync("curl", ["--fail", "--silent", "--show-error", "--insecure", "https://localhost/health"], { encoding: "utf8" });
  if (health.status !== 0) throw new Error(health.stderr || "Compact machine edge health check failed.");
  console.log("Compact machine deployment smoke test passed.");
} finally {
  compose(["down", "--volumes"]);
}
