import { readFile } from "node:fs/promises";

const root = "deployments/kubernetes/scalable-single-cell";
const files = await Promise.all(["kustomization.yaml", "configmap.yaml", "api.yaml", "worker.yaml", "web.yaml", "admin.yaml", "service.yaml", "ingress.yaml", "network-policy.yaml", "secret.example.yaml"].map(async (name) => [name, await readFile(`${root}/${name}`, "utf8")]));
const content = Object.fromEntries(files);
for (const [name, required] of Object.entries({ "kustomization.yaml": ["apiVersion: kustomize", "api.yaml", "worker.yaml", "web.yaml", "admin.yaml"], "configmap.yaml": ["UBEEQ_CELL_ID", "UBEEQ_PUBLIC_BASE_URL"], "api.yaml": ["machine-server.js", "/ready", "runAsNonRoot"], "worker.yaml": ["machine-worker.js", "runAsNonRoot"], "web.yaml": ["web-reference", "UBEEQ_REFERENCE_API_URL"], "admin.yaml": ["admin-reference", "UBEEQ_REFERENCE_API_URL"], "secret.example.yaml": ["UBEEQ_POSTGRES_URL", "UBEEQ_S3_ENDPOINT"], "ingress.yaml": ["kind: Ingress", "ubeeq-web", "ubeeq-admin", "tls:"], "network-policy.yaml": ["kind: NetworkPolicy"] })) for (const value of required) if (!content[name].includes(value)) throw new Error(`${name} is missing ${value}`);
console.log("Ubeeq scalable Kubernetes single-cell manifests are complete");
