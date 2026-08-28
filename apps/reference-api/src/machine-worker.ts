import { createMachineReferenceApi } from "./machine.js";

const workerId = process.env.UBEEQ_WORKER_ID ?? `machine-worker-${process.pid}`;
const pollMilliseconds = Math.max(50, Number(process.env.UBEEQ_WORKER_POLL_MILLISECONDS ?? 250));
void (async () => {
  const { api, database } = await createMachineReferenceApi();
  let stopping = false;
  const stop = (): void => { stopping = true; };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const wait = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
  while (!stopping) {
    try { if (!await api.runNextJob(workerId)) await wait(); }
    catch (error) { console.error("Ubeeq scalable machine worker failed a job; durable retry state was recorded.", error); await wait(); }
  }
  await database.close();
})().catch((error) => { console.error("Ubeeq scalable machine worker failed to start.", error); process.exitCode = 1; });
