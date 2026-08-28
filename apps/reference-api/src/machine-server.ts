import { createMachineReferenceApi } from "./machine.js";

const port = Number(process.env.PORT ?? 4100);
const host = process.env.UBEEQ_LISTEN_HOST ?? "127.0.0.1";
void (async () => {
  const { api, database } = await createMachineReferenceApi();
  api.server.listen(port, host, () => console.log(`Ubeeq scalable machine API listening on http://${host}:${port}`));
  const stop = async (): Promise<void> => { await new Promise<void>((resolve) => api.server.close(() => resolve())); await database.close(); };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
})().catch((error) => { console.error("Ubeeq scalable machine API failed to start.", error); process.exitCode = 1; });
