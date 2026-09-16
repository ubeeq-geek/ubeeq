/** One in-flight task per worker; stop closes admission and drains accepted work. */
export function startPeriodicWorkers(workers: Array<{ intervalMs: number; run(): Promise<unknown>; onError(): void }>) {
  for (const worker of workers) if (!Number.isSafeInteger(worker.intervalMs) || worker.intervalMs < 1) throw new Error('Invalid worker interval.');
  let stopping = false;
  const entries = workers.map(worker => {
    let pending: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (stopping || pending) return;
      pending = Promise.resolve().then(() => worker.run()).then(() => undefined).catch(() => {
        try { worker.onError(); } catch { /* Reporting must not create an unhandled worker rejection. */ }
      }).finally(() => { pending = undefined; });
    }, worker.intervalMs);
    timer.unref();
    return { timer, pending: () => pending };
  });
  return { async stop() {
    stopping = true;
    for (const entry of entries) clearInterval(entry.timer);
    await Promise.all(entries.map(entry => entry.pending()));
  } };
}
