import { readFile } from "node:fs/promises";

const compose = await readFile("examples/machine/compact/compose.yaml", "utf8");
const dockerfile = await readFile("examples/machine/compact/Dockerfile", "utf8");
const caddyfile = await readFile("examples/machine/compact/Caddyfile", "utf8");
const environment = await readFile("examples/machine/compact/.env.example", "utf8");
const scalable = await readFile("examples/machine/scalable-single-cell/compose.yaml", "utf8");
for (const required of ["reference-api:", "reference-worker:", "reference-web:", "reference-admin:", "caddy:", "ubeeq-data:", "UBEEQ_LISTEN_HOST: 0.0.0.0", "UBEEQ_REFERENCE_API_URL: http://reference-api:4100", "UBEEQ_CREDENTIAL_ENCRYPTION_KEY", "condition: service_healthy"]) if (!compose.includes(required)) throw new Error(`Compact machine example is missing ${required}`);
for (const required of ["node:22", "npm ci", "npm run build"]) if (!dockerfile.includes(required)) throw new Error(`Compose Dockerfile is missing ${required}`);
for (const required of ["reverse_proxy reference-api:4100", "reverse_proxy reference-web:4173", "reverse_proxy reference-admin:4174"]) if (!caddyfile.includes(required)) throw new Error(`Compact machine TLS edge is missing ${required}`);
for (const required of ["UBEEQ_PUBLIC_HOST", "UBEEQ_CREDENTIAL_ENCRYPTION_KEY"]) if (!environment.includes(required)) throw new Error(`Compact machine environment template is missing ${required}`);
for (const required of ["postgres:", "minio:", "minio-init:", "reference-worker:", "UBEEQ_POSTGRES_URL", "UBEEQ_S3_ENDPOINT", "condition: service_completed_successfully"]) if (!scalable.includes(required)) throw new Error(`Scalable machine example is missing ${required}`);
console.log("Ubeeq compact machine example is complete");
