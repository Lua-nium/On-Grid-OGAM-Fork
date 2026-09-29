import { CATALOG, searchHuggingFace, getModelFiles } from '@offgrid/models';
import RNFS from 'react-native-fs';
import type { ImageModelDescriptor } from './imageModelDownloadTypes';

export interface HFImageModel {
  id: string;
  name: string;
  displayName: string;
  backend: ImageModelDescriptor['backend'];
  huggingFaceFiles?: ImageModelDescriptor['huggingFaceFiles'];
  variant?: string;
  downloadUrl: string;
  fileName: string;
  size: number;
  repo: string;
}

interface HFTreeEntry {
  type: string;
  path: string;
  size: number;
  lfs?: { oid: string; size: number; pointerSize: number };
}

const REPOS = {
  mnn: 'xororz/sd-mnn',
  qnn: 'xororz/sd-qnn',
} as const;

const VARIANT_LABELS: Record<string, string> = {
  min: 'For non-flagship Snapdragon chips',
  '8gen1': 'For Snapdragon 8 Gen 1',
  '8gen2': 'For Snapdragon 8 Gen 2/3/4/5',
};

let cachedModels: HFImageModel[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function insertSpaces(name: string): string {
  // Insert space before uppercase letters that follow lowercase or digits
  // e.g. "AnythingV5" -> "Anything V5", "AbsoluteReality" -> "Absolute Reality"
  return name.replaceAll(/([a-z\d])([A-Z])/g, '$1 $2');
}

function parseFileName(fileName: string, backend: 'mnn' | 'qnn'): Omit<HFImageModel, 'downloadUrl' | 'size' | 'repo'> | null {
  if (!fileName.endsWith('.zip')) return null;

  const baseName = fileName.replace('.zip', '');

  if (backend === 'qnn') {
    // NPU: e.g. "AnythingV5_qnn2.28_8gen2.zip"
    const match = baseName.match(/^(.+?)_qnn[\d.]+_(.+)$/);
    if (!match) return null;
    const [, name, variant] = match;
    const displayVariant = variant === 'min' ? 'non-flagship' : variant;
    return {
      id: `${name.toLowerCase()}_npu_${variant}`,
      name,
      displayName: `${insertSpaces(name)} (NPU ${displayVariant})`,
      backend: 'qnn',
      variant,
      fileName,
    };
  }

  // GPU: e.g. "AnythingV5.zip"
  return {
    id: `${baseName.toLowerCase()}_cpu`,
    name: baseName,
    displayName: `${insertSpaces(baseName)} (GPU)`,
    backend: 'mnn',
    fileName,
  };
}

async function fetchRepoFiles(repo: string): Promise<HFTreeEntry[]> {
  const response = await fetch(`https://huggingface.co/api/models/${repo}/tree/main`);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${repo}: HTTP ${response.status}`);
  }
  return response.json();
}

export async function fetchAvailableModels(forceRefresh = false, opts?: { skipQnn?: boolean }): Promise<HFImageModel[]> {
  if (!forceRefresh && cachedModels && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedModels;
  }

  const fetchQnn = !opts?.skipQnn;
  const [mnnFiles, qnnFiles] = await Promise.all([
    fetchRepoFiles(REPOS.mnn),
    fetchQnn ? fetchRepoFiles(REPOS.qnn) : Promise.resolve([] as HFTreeEntry[]),
  ]);

  const models: HFImageModel[] = [];

  for (const entry of mnnFiles) {
    if (entry.type !== 'file') continue;
    const parsed = parseFileName(entry.path, 'mnn');
    if (!parsed) continue;
    models.push({
      ...parsed,
      downloadUrl: `https://huggingface.co/${REPOS.mnn}/resolve/main/${entry.path}`,
      size: entry.lfs?.size ?? entry.size,
      repo: REPOS.mnn,
    });
  }

  for (const entry of qnnFiles) {
    if (entry.type !== 'file') continue;
    const parsed = parseFileName(entry.path, 'qnn');
    if (!parsed) continue;
    models.push({
      ...parsed,
      downloadUrl: `https://huggingface.co/${REPOS.qnn}/resolve/main/${entry.path}`,
      size: entry.lfs?.size ?? entry.size,
      repo: REPOS.qnn,
    });
  }

  // Sort: GPU first, then NPU; alphabetically within each group
  models.sort((a, b) => {
    if (a.backend !== b.backend) return a.backend === 'mnn' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  cachedModels = models;
  cacheTimestamp = Date.now();
  return models;
}

export function getVariantLabel(variant?: string): string | undefined {
  return variant ? VARIANT_LABELS[variant] : undefined;
}

export function guessStyle(name: string): string {
  const lower = name.toLowerCase();
  if (
    lower.includes('reality') ||
    lower.includes('realistic') ||
    lower.includes('chillout') ||
    lower.includes('photo')
  ) {
    return 'photorealistic';
  }
  return 'anime';
}

/** The shared catalog owns the Qwen pack, including pinned companion files. */
export function getSDImageModels(): HFImageModel[] {
  return CATALOG.filter(model => model.id === 'leejet/Qwen-Image-2.1-GGUF').map(model => ({
    id: `sd-${model.id.replaceAll('/', '--')}`,
    name: model.name, displayName: model.name, backend: 'sd' as const,
    repo: model.id, fileName: model.files[0].name, downloadUrl: model.files[0].url,
    size: model.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
    huggingFaceFiles: model.files.map(file => ({ path: file.name, size: file.sizeBytes ?? 0, downloadUrl: file.url, sha256: file.sha256 })),
  }));
}

/** Supported SD image weights; other architectures need their own complete pack. */
export const isSDImageWeight = (name: string): boolean => /^qwen_image_2\.1-.*\.gguf$/i.test(name);

/** The same required-file list is used by loading, recovery, and model transfer. */
export function getSDImagePackFiles(names: string[], modelId?: string): NonNullable<HFImageModel['huggingFaceFiles']> | null {
  const weights = names.filter(isSDImageWeight);
  if (weights.length !== 1) return null;
  const template = getSDImageModels()[0];
  if (!template?.huggingFaceFiles) return null;
  return template.huggingFaceFiles.map(file => file.path === template.fileName
    ? { path: weights[0], size: 0, sha256: modelId === template.id && weights[0] === file.path ? file.sha256 : undefined }
    : file);
}

export async function searchSDImageModels(query: string): Promise<HFImageModel[]> {
  const repositories = await searchHuggingFace(query, { kind: 'image', limit: 10 });
  const template = getSDImageModels()[0];
  if (!template?.huggingFaceFiles) return [];
  const companion = template.huggingFaceFiles.filter(file => file.path !== template.fileName);
  const listings = await Promise.allSettled(repositories.map(async repo => {
    const files = await getModelFiles(repo.id, { kind: 'image' });
    return files.filter(file => isSDImageWeight(file.fileName) && file.sizeBytes > 0).map(file => {
      const canonical = repo.id === template.repo && file.fileName === template.fileName;
      if (canonical) return template;
      const id = `sd-${repo.id.replaceAll('/', '--')}--${file.fileName}`;
      return {
        id, name: `${template.name} ${file.quant}`, displayName: `${template.displayName} · ${file.quant}`,
        backend: 'sd' as const, repo: repo.id, fileName: file.fileName,
        downloadUrl: file.downloadUrl,
        size: file.sizeBytes + companion.reduce((sum, part) => sum + part.size, 0),
        huggingFaceFiles: [{ path: file.fileName, size: file.sizeBytes, downloadUrl: file.downloadUrl, sha256: file.sha256 }, ...companion],
      };
    }).filter(model => model.id.length <= 160);
  }));
  if (listings.length && listings.every(result => result.status === 'rejected')) {
    throw new Error('Could not read image model files from Hugging Face. Try again.');
  }
  return listings.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}

export async function resolveSDImagePack(_modelId: string, modelPath: string) {
  const files = getSDImagePackFiles((await RNFS.readDir(modelPath)).filter(file => file.isFile()).map(file => file.name));
  if (!files) throw new Error('This image model pack is not supported.');
  const required = (pattern: RegExp) => {
    const file = files.find(part => pattern.test(part.path));
    if (!file) throw new Error('The image model pack is incomplete.');
    return `${modelPath}/${file.path}`;
  };
  return {
    weight: required(/^qwen_image_2\.1-.*\.gguf$/i),
    vae: required(/vae.*\.safetensors$/i),
    llm: required(/^Qwen3VL-.*\.gguf$/i),
  };
}
