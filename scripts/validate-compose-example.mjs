import { readFile } from "node:fs/promises";

const compose = await readFile("examples/machine/compact/compose.yaml", "utf8");
const dockerfile = await readFile("examples/machine/compact/Dockerfile", "utf8");
for (const required of ["reference-api:", "reference-web:", "reference-admin:", "ubeeq-data:", "UBEEQ_LISTEN_HOST: 0.0.0.0", "UBEEQ_REFERENCE_API_URL: http://reference-api:4100"]) if (!compose.includes(required)) throw new Error(`Compact machine example is missing ${required}`);
for (const required of ["node:22", "npm ci", "@ubeeq/reference-api"]) if (!dockerfile.includes(required)) throw new Error(`Compose Dockerfile is missing ${required}`);
console.log("Ubeeq compact machine example is complete");
