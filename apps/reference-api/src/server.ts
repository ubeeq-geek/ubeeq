export * from '@ubeeq/runtime';
import { createCoreRuntime, referenceApiConfigurationFromEnvironment } from '@ubeeq/runtime';
if (require.main === module) {
  const port = Number(process.env.PORT ?? 4100);
  const api = createCoreRuntime(referenceApiConfigurationFromEnvironment());
  const host = process.env.UBEEQ_LISTEN_HOST ?? '127.0.0.1';
  api.server.listen(port, host, () => console.log(`Ubeeq reference API listening on http://${host}:${port}`));
}
