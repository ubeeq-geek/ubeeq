import { createReferenceApi, referenceApiConfigurationFromEnvironment } from "./server.js";

const workerId = process.env.UBEEQ_WORKER_ID ?? `compact-worker-${process.pid}`;
const pollMilliseconds = Math.max(50, Number(process.env.UBEEQ_WORKER_POLL_MILLISECONDS ?? 250));
const api = createReferenceApi(referenceApiConfigurationFromEnvironment());
let stopping = false;

const wait = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
const stop = (): void => { stopping = true; };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

const run = async (): Promise<void> => {
  console.log(`Ubeeq reference worker ${workerId} is running.`);
  while (!stopping) {
    try {
      const result = await api.runNextJob(workerId);
      if (!result) await wait();
    } catch (error) {
      console.error("Ubeeq reference worker failed a job; its durable retry state was recorded.", error);
      await wait();
    }
  }
  console.log(`Ubeeq reference worker ${workerId} stopped.`);
};

void run().catch((error) => { console.error("Ubeeq reference worker stopped unexpectedly.", error); process.exitCode = 1; });
