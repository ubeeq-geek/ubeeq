import { readFile } from "node:fs/promises";

const compose = await readFile("examples/compose-self-host/compose.yaml", "utf8");
const dockerfile = await readFile("examples/compose-self-host/Dockerfile", "utf8");
for (const required of ["reference-api:", "reference-web:", "reference-admin:", "ubeeq-data:", "UBEEQ_LISTEN_HOST: 0.0.0.0", "UBEEQ_REFERENCE_API_URL: http://reference-api:4100"]) if (!compose.includes(required)) throw new Error(`Compose self-host example is missing ${required}`);
for (const required of ["node:22", "npm ci", "@ubeeq/reference-api"]) if (!dockerfile.includes(required)) throw new Error(`Compose Dockerfile is missing ${required}`);
console.log("Ubeeq Compose self-host example is complete");
