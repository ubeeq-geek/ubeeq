import { createMachineAdapterSet } from "@ubeeq/adapter-machine";
import { createReferenceApi, type ReferenceAdapterSet } from "./server.js";

const required = (environment: NodeJS.ProcessEnv, name: string): string => {
  const value = environment[name];
  if (!value?.trim()) throw new Error(`${name} must be configured for a scalable machine cell.`);
  return value;
};

/** Creates the same HTTP application over PostgreSQL and an S3-compatible regional object store. */
export const createMachineReferenceApi = async (environment: NodeJS.ProcessEnv = process.env) => {
  const cellId = required(environment, "UBEEQ_CELL_ID");
  const adapters = await createMachineAdapterSet({
    connectionString: required(environment, "UBEEQ_POSTGRES_URL"),
    cellId,
    sessionTtlSeconds: environment.UBEEQ_SESSION_TTL_SECONDS ? Number(environment.UBEEQ_SESSION_TTL_SECONDS) : undefined,
    storage: {
      endpoint: required(environment, "UBEEQ_S3_ENDPOINT"),
      region: environment.UBEEQ_S3_REGION,
      bucket: required(environment, "UBEEQ_S3_BUCKET"),
      accessKeyId: environment.UBEEQ_S3_ACCESS_KEY_ID,
      secretAccessKey: environment.UBEEQ_S3_SECRET_ACCESS_KEY,
      forcePathStyle: environment.UBEEQ_S3_FORCE_PATH_STYLE !== "false",
      directUploads: environment.UBEEQ_S3_DIRECT_UPLOADS === "true",
      cellId,
    },
  });
  const api = createReferenceApi({
    instanceId: required(environment, "UBEEQ_INSTANCE_ID"),
    publicBaseUrl: required(environment, "UBEEQ_PUBLIC_BASE_URL"),
    cellId,
    region: required(environment, "UBEEQ_CELL_REGION"),
    operator: required(environment, "UBEEQ_CELL_OPERATOR"),
    adapters: adapters as ReferenceAdapterSet,
    diagnostics: [{ name: "postgres", check: async () => { await adapters.database.pool.query("SELECT 1"); return { status: "ok" as const }; } }],
  });
  return { api, database: adapters.database };
};
