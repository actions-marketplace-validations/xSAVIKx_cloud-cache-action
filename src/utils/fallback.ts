import * as cache from '@actions/cache';
import * as core from '@actions/core';

export async function fallbackRestore(
  paths: string[],
  primaryKey: string,
  restoreKeys: string[],
  options?: { lookupOnly?: boolean },
  enableCrossOsArchive?: boolean
): Promise<string | undefined> {
  core.info('Attempting fallback restore using official GitHub Actions Cache service...');
  try {
    const matchedKey = await cache.restoreCache(
      paths,
      primaryKey,
      restoreKeys,
      options,
      enableCrossOsArchive
    );
    return matchedKey;
  } catch (err: unknown) {
    core.warning(
      `GitHub Actions Cache fallback restore failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return undefined;
  }
}

export async function fallbackSave(
  paths: string[],
  key: string,
  options?: { uploadChunkSize?: number },
  enableCrossOsArchive?: boolean
): Promise<number | void> {
  core.info('Attempting fallback save using official GitHub Actions Cache service...');
  try {
    return await cache.saveCache(paths, key, options, enableCrossOsArchive);
  } catch (err: unknown) {
    core.warning(
      `GitHub Actions Cache fallback save failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
