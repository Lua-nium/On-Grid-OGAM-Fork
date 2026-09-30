import { CATALOG, videoPackError } from '@offgrid/models';
import { videoGenerator } from './videoGenerator';
import { recommendedModelsForDevice, ramFitScore } from '../utils/recommendedModels';
import { fileExceedsBudget } from './memoryBudget';
import { fetchModelFiles } from './modelCatalogFiles';
import { hardwareService } from './hardware';
import { WHISPER_MODELS } from './whisperModels';
import type { AutoSetupCompatibleCatalog } from './autoSetupPlan';
import { autoSetupImageCatalogProvider } from './autoSetupImageCatalogProvider';

const MB = 1024 * 1024;

type CompatibleTextModel = ReturnType<typeof recommendedModelsForDevice>[number];

export interface AutoSetupCatalogBoundaries {
  totalMemoryGB: () => number | Promise<number>;
  videoAvailable?: () => boolean;
  fetchTextFiles: typeof fetchModelFiles;
  imageRecommendation: typeof hardwareService.getImageModelRecommendation;
  imageModels: typeof autoSetupImageCatalogProvider.load;
}

const productionCatalogBoundaries: AutoSetupCatalogBoundaries = {
  totalMemoryGB: async () => {
    await hardwareService.getDeviceInfo();
    return hardwareService.getTotalMemoryGB();
  },
  videoAvailable: () => videoGenerator.available(),
  fetchTextFiles: fetchModelFiles,
  imageRecommendation: () => hardwareService.getImageModelRecommendation(),
  imageModels: () => autoSetupImageCatalogProvider.load(),
};

export function buildAutoSetupTextCandidates(
  models: CompatibleTextModel[],
  files: Record<string, import('../types').ModelFile[]>,
  ramGB: number,
): AutoSetupCompatibleCatalog['text'] {
  return models.filter(model => model.type === 'vision').flatMap(model => {
    const file = files[model.id]?.[0];
    const sizeBytes = file ? file.size + (file.mmProjFile?.size ?? 0) : 0;
    if (!file || fileExceedsBudget(sizeBytes, ramGB)) return [];
    return [{
      id: `${model.id}/${file.name}`,
      name: model.name,
      kind: 'text' as const,
      sizeBytes,
      fitScore: ramFitScore(model.minRam, ramGB),
      parameterCountB: model.params,
      payload: { modelId: model.id, file },
    }];
  });
}

/** Resolve the live catalogs, then admit candidates through the existing device-fit owners. */
export async function loadAutoSetupCompatibleCatalog(
  boundaries: AutoSetupCatalogBoundaries = productionCatalogBoundaries,
): Promise<AutoSetupCompatibleCatalog> {
  const ramGB = await boundaries.totalMemoryGB();
  const textModels = recommendedModelsForDevice(ramGB).filter(model => model.type === 'vision');
  const files = await boundaries.fetchTextFiles(textModels);
  const text = buildAutoSetupTextCandidates(textModels, files, ramGB);

  const imageRecommendation = await boundaries.imageRecommendation();
  const imageModels = await boundaries.imageModels();
  const compatibleImages = imageModels.filter(model =>
    imageRecommendation.compatibleBackends.includes(model.backend) &&
    (!imageRecommendation.qnnVariant || model.backend !== 'qnn' || model.variant === imageRecommendation.qnnVariant) &&
    !fileExceedsBudget(model.size, ramGB),
  );
  const recommendedBackendImages = compatibleImages.filter(
    model => model.backend === imageRecommendation.recommendedBackend,
  );
  const imageCandidates = recommendedBackendImages.length > 0 ? recommendedBackendImages : compatibleImages;
  const image = imageCandidates.map((model, index) => ({
    id: model.id,
    name: model.name,
    kind: 'image' as const,
    sizeBytes: model.size,
    fitScore: imageRecommendation.recommendedModels?.some(label =>
      [model.name, model.repo, model.id].some(value => value?.toLowerCase().includes(label)),
    ) ? 0 : index + 1,
    payload: model,
  }));

  const stt = WHISPER_MODELS.filter(model =>
    model.lang === 'multi' && !fileExceedsBudget(model.size * MB, ramGB),
  ).map(model => ({
    id: model.id,
    name: `${model.name} Speech`,
    kind: 'stt' as const,
    sizeBytes: model.size * MB,
    fitScore: Math.abs(model.size - Math.min(809, ramGB * 100)),
    payload: { modelId: model.id },
  }));

  const completeVideoPacks = CATALOG.filter(model =>
    model.kind === 'video' && model.availability !== 'coming_soon' &&
    !!model.minRamGb && !videoPackError(model.files) &&
    model.files.every(file => !!file.sizeBytes),
  );
  const videoAvailable = boundaries.videoAvailable?.() ?? false;
  const video = videoAvailable ? completeVideoPacks.flatMap(model => {
    if (model.minRamGb! > ramGB) return [];
    const sizeBytes = model.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
    if (fileExceedsBudget(sizeBytes, ramGB)) return [];
    return [{
      id: model.id, name: model.name, kind: 'video' as const, sizeBytes,
      fitScore: ramFitScore(model.minRamGb!, ramGB), payload: model,
    }];
  }) : [];
  const minimumVideoRamGB = Math.min(...completeVideoPacks.map(model => model.minRamGb!));
  const videoExclusionReason = video.length ? undefined
    : !videoAvailable ? 'This app build does not include the local video engine.'
    : !completeVideoPacks.length ? 'No complete video model pack is available in the catalog.'
    : ramGB < minimumVideoRamGB
      ? `Auto Setup recommends at least ${minimumVideoRamGB} GB RAM for video. This device reports ${ramGB.toFixed(1)} GB. Select Configure it yourself to review video models.`
      : 'Video packs exceed this device\'s Auto Setup memory budget. Select Configure it yourself to review video models.';
  return { text, image, stt, video, videoExclusionReason };
}
