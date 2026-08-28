import { spawnSync } from "node:child_process";

const composeDirectory = new URL("../examples/machine/scalable-single-cell/", import.meta.url).pathname;
const environment = {
  ...process.env,
  UBEEQ_PUBLIC_HOST: process.env.UBEEQ_PUBLIC_HOST ?? "localhost",
  UBEEQ_INSTANCE_ID: process.env.UBEEQ_INSTANCE_ID ?? "scalable-smoke",
  UBEEQ_CELL_ID: process.env.UBEEQ_CELL_ID ?? "scalable-smoke-cell",
  UBEEQ_CELL_REGION: process.env.UBEEQ_CELL_REGION ?? "local",
  UBEEQ_CELL_OPERATOR: process.env.UBEEQ_CELL_OPERATOR ?? "Smoke test",
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? "scalable-smoke-postgres-password",
  MINIO_ROOT_USER: process.env.MINIO_ROOT_USER ?? "scalablesmoke",
  MINIO_ROOT_PASSWORD: process.env.MINIO_ROOT_PASSWORD ?? "scalable-smoke-minio-secret",
  UBEEQ_S3_BUCKET: process.env.UBEEQ_S3_BUCKET ?? "ubeeq-smoke-objects",
};
const compose = (arguments_) => spawnSync("docker", ["compose", ...arguments_], { cwd: composeDirectory, env: environment, encoding: "utf8" });
const configured = compose(["config", "--quiet"]);
if (configured.error?.code === "ENOENT") { console.log("Skipping scalable machine Docker smoke test because Docker is unavailable."); process.exit(0); }
if (configured.status !== 0) throw new Error(configured.stderr || "Scalable machine Compose configuration is invalid.");
console.log("Scalable machine Compose configuration is valid. Set RUN_MACHINE_SCALABLE_SMOKE=1 to build, start, and probe the deployment.");
if (process.env.RUN_MACHINE_SCALABLE_SMOKE !== "1") process.exit(0);
try {
  const started = compose(["up", "--build", "--detach", "--wait"]);
  if (started.status !== 0) throw new Error(started.stderr || "Scalable machine deployment did not become healthy.");
  const health = spawnSync("curl", ["--fail", "--silent", "--show-error", "--insecure", "https://localhost/health"], { encoding: "utf8" });
  if (health.status !== 0) throw new Error(health.stderr || "Scalable machine edge health check failed.");
  console.log("Scalable machine deployment smoke test passed.");
} finally { compose(["down", "--volumes"]); }
