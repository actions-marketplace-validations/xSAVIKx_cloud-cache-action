import * as cache from '@actions/cache';
import { isExactKeyMatch } from '../utils/inputUtils';
import { toError, type RestoreOutcome, type SaveOutcome } from './outcomes';

export async function restoreFromGitHub(
  paths: readonly string[],
  primaryKey: string,
  restoreKeys: readonly string[],
  lookupOnly: boolean,
  enableCrossOsArchive: boolean
): Promise<RestoreOutcome> {
  try {
    const matchedKey = await cache.restoreCache(
      [...paths],
      primaryKey,
      [...restoreKeys],
      { lookupOnly },
      enableCrossOsArchive
    );
    if (!matchedKey) {
      return { kind: 'miss' };
    }
    return { kind: 'hit', matchedKey, exact: isExactKeyMatch(primaryKey, matchedKey) };
  } catch (err) {
    return { kind: 'error', error: toError(err) };
  }
}

/**
 * Whether GitHub Actions Cache already holds exactly `key`. A lookup also returns prefix
 * matches, which do not count. Service failures throw so callers can apply strict mode.
 */
export async function existsInGitHub(
  paths: readonly string[],
  key: string,
  enableCrossOsArchive: boolean
): Promise<boolean> {
  const matchedKey = await cache.restoreCache(
    [...paths],
    key,
    [],
    { lookupOnly: true },
    enableCrossOsArchive
  );
  return isExactKeyMatch(key, matchedKey);
}

export async function saveToGitHub(
  paths: readonly string[],
  key: string,
  uploadChunkSize: number | undefined,
  enableCrossOsArchive: boolean
): Promise<SaveOutcome> {
  try {
    const cacheId = await cache.saveCache(
      [...paths],
      key,
      { uploadChunkSize },
      enableCrossOsArchive
    );
    // -1 means @actions/cache did not save and already logged why: another job is creating
    // the entry, the cache mode forbids writes, or it swallowed a service error itself.
    if (cacheId === -1) {
      return {
        kind: 'skipped',
        reason: 'GitHub Actions Cache did not save this key (see the messages above)',
      };
    }
    return { kind: 'saved' };
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === 'ValidationError' &&
      err.message.startsWith('Path Validation Error')
    ) {
      return { kind: 'skipped', reason: 'no paths matched' };
    }
    return { kind: 'error', error: toError(err) };
  }
}
