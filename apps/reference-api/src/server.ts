export * from '@ubeeq/runtime';
import { createCoreRuntime, referenceApiConfigurationFromEnvironment as runtimeConfiguration } from '@ubeeq/runtime';
import { FfmpegSlideshowRenderer } from '@ubeeq/media-ffmpeg';

export function referenceApiConfigurationFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const configuration = runtimeConfiguration(environment);
  const ffmpegPath = environment.UBEEQ_FFMPEG_PATH;
  const ffprobePath = environment.UBEEQ_FFPROBE_PATH;
  return ffmpegPath && ffprobePath
    ? {...configuration, slideshowRenderer: new FfmpegSlideshowRenderer({ffmpegPath, ffprobePath})}
    : configuration;
}
if (require.main === module) {
  const port = Number(process.env.PORT ?? 4100);
  const api = createCoreRuntime(referenceApiConfigurationFromEnvironment());
  const host = process.env.UBEEQ_LISTEN_HOST ?? '127.0.0.1';
  api.server.listen(port, host, () => console.log(`Ubeeq reference API listening on http://${host}:${port}`));
}
