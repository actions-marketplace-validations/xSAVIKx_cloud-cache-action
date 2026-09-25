import { createHash } from 'node:crypto';
import type { CompressionMethod } from '../archive/compression';
import { Defaults } from '../constants';

export const VERSION_LENGTH = 16;

/**
 * Identifies what a cache archive contains, as actions/cache does: the raw `path` patterns
 * (not the files they match, so `~/.npm` is stable across machines), the compression
 * method, and whether a Windows cache may be shared with other operating systems.
 */
export function computeCacheVersion(
  paths: readonly string[],
  compression: CompressionMethod,
  enableCrossOsArchive: boolean,
  platform: NodeJS.Platform = process.platform
): string {
  const components = paths.map((p) => p.trim());
  components.push(compression);
  if (platform === 'win32' && !enableCrossOsArchive) {
    components.push('windows-only');
  }
  components.push(Defaults.VersionSalt);
  return createHash('sha256').update(components.join('|')).digest('hex').slice(0, VERSION_LENGTH);
}
