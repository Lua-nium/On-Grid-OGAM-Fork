import { NativeEventEmitter, NativeModules } from 'react-native';
import { videoArchitecture } from '@offgrid/models';
import type {
  ResolvedVideoRequest,
  VideoModelPack,
  VideoGenerationUpdateContract,
} from '@offgrid/models';
const native = NativeModules.VideoGenerationModule;
export const videoGenerator = {
  available: () => !!native,
  cancel: async (): Promise<void> => {
    if (native) await native.cancel();
  },
  async generate(
    request: ResolvedVideoRequest,
    pack: VideoModelPack,
    outputPath: string,
    onUpdate: (update: VideoGenerationUpdateContract) => void,
  ): Promise<string> {
    if (!native)
      throw new Error('This build does not include the video engine.');
    // Step zero marks the start of sampling, before the first step completes.
    let lastStep = -1;
    const listener = new NativeEventEmitter(native).addListener(
      'VideoGenerationProgress',
      event => {
        // sd.cpp also sends tensor-loading and VAE tile counters through this
        // callback. Only sampling steps belong in the generation step count.
        if (event.stage === 'generating') {
          if (
            event.total !== request.steps ||
            event.step <= lastStep ||
            event.step > request.steps
          )
            return;
          lastStep = event.step;
        }
        onUpdate({
          stage: event.stage,
          backend: event.backend ?? null,
          ...(event.preview &&
          event.preview.path === `${outputPath}.preview.png` &&
          Number.isFinite(event.preview.width) && event.preview.width > 0 &&
          Number.isFinite(event.preview.height) && event.preview.height > 0
            ? { preview: event.preview }
            : {}),
          progress:
            event.total > 0 ? { step: event.step, total: event.total } : null,
        });
      },
    );
    try {
      return (
        await native.generate({
          ...request,
          ...pack,
          outputPath,
          flowShift: videoArchitecture(pack.weight)?.startsWith('wan') ? 3 : 0,
        })
      ).path;
    } finally {
      listener.remove();
    }
  },
};
