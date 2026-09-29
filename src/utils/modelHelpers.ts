import { CATALOG } from '@offgrid/models';
import { DownloadedModel } from '../types';

export const getMmProjFileSize = (m?: DownloadedModel): number =>
  m?.engine === 'llama' ? (m.mmProjFileSize ?? 0) : 0;

/**
 * The ONE test for "is this a LiteRT model file".
 *
 * Five call sites each spelled the extension out — the import guard, the import display name, the
 * registry row builder, the multi-file picker and the acceleration check. A format is one fact
 * about a file, so it gets one answer; adding a second LiteRT extension used to mean finding all
 * five.
 */
export const isLiteRTFileName = (fileName: string): boolean =>
  fileName.toLowerCase().endsWith('.litertlm');

/** Use the catalog label without changing the repository ID or file names. */
export const videoModelDisplayName = (id: string, fallback: string = id): string =>
  CATALOG.find(model => model.kind === 'video' && model.id === id)?.name ?? fallback;
