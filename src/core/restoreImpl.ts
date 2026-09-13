import * as core from '@actions/core';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { Inputs, Outputs, State, Defaults } from '../constants';
import { IStateProvider, StateProvider, NullStateProvider } from '../state';
import {
  getInputAsArray,
  getInputAsBool,
  getInputAsInt,
  formatSize,
  isExactKeyMatch,
  isValidEvent,
} from '../utils/inputUtils';
import { buildS3ObjectKey, buildS3SearchPrefix, extractKeyFromS3Object } from '../utils/pathUtils';
import { createStorageContext, StorageContext } from '../storage/client';
import { checkObjectExists, listObjectsWithPrefix, downloadFile } from '../storage/operations';
import { withRetry } from '../storage/retry';
import { getCompressionConfig, CompressionConfig } from '../archive/compression';
import { extractArchive } from '../archive/tar';
import { fallbackRestore } from '../utils/fallback';

export interface S3RestoreResult {
  matchedKey: string;
  isExactHit: boolean;
  s3ObjectKey: string;
  size: number;
  etag?: string;
}

export async function restoreFromS3(
  storageContext: StorageContext,
  primaryKey: string,
  restoreKeys: string[],
  s3KeyPattern: string,
  prefix: string,
  scopedToRepository: boolean,
  retryEnabled: boolean,
  retryCount: number,
  lookupOnly: boolean,
  compression: CompressionConfig
): Promise<S3RestoreResult | null> {
  const { client, bucket } = storageContext;

  const exactObjectKey = buildS3ObjectKey({
    key: primaryKey,
    prefix,
    archiveFilename: compression.archiveFilename,
    pattern: s3KeyPattern,
    scopedToRepository,
  });

  core.debug(`Checking exact S3 key match: ${exactObjectKey} in bucket: ${bucket}`);

  let exactObject = null;
  try {
    exactObject = await withRetry(() => checkObjectExists(client, bucket, exactObjectKey), {
      retries: retryEnabled ? retryCount : 0,
      operationName: `checkObjectExists (${exactObjectKey})`,
    });
  } catch (err) {
    core.warning(
      `Error checking S3 cache object: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (exactObject) {
    core.info(`Exact S3 cache hit on key: ${primaryKey} (${formatSize(exactObject.size)})`);

    if (!lookupOnly) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-'));
      const localArchive = path.join(tempDir, compression.archiveFilename);
      try {
        core.info(`Downloading cache archive from s3://${bucket}/${exactObjectKey}...`);
        await withRetry(() => downloadFile(client, bucket, exactObjectKey, localArchive), {
          retries: retryEnabled ? retryCount : 0,
          operationName: `downloadFile (${exactObjectKey})`,
        });

        core.info(`Extracting cache archive to working directory...`);
        await extractArchive(localArchive, compression);
        core.info(`Cache restored successfully from S3 key: ${primaryKey}`);
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup error
        }
      }
    }

    return {
      matchedKey: primaryKey,
      isExactHit: true,
      s3ObjectKey: exactObjectKey,
      size: exactObject.size,
      etag: exactObject.etag,
    };
  }

  // Exact match not found; search restore-keys in S3
  core.debug(`Exact S3 match not found. Searching restore keys: ${restoreKeys.join(', ')}`);

  for (const restoreKey of restoreKeys) {
    const searchPrefix = buildS3SearchPrefix(restoreKey, {
      prefix,
      pattern: s3KeyPattern,
      scopedToRepository,
    });

    try {
      const objects = await withRetry(() => listObjectsWithPrefix(client, bucket, searchPrefix), {
        retries: retryEnabled ? retryCount : 0,
        operationName: `listObjectsWithPrefix (${searchPrefix})`,
      });

      const validObjects = objects.filter(
        (o) =>
          o.key.endsWith(`/${compression.archiveFilename}`) ||
          o.key.endsWith(compression.archiveFilename)
      );

      if (validObjects.length > 0) {
        validObjects.sort(
          (a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0)
        );

        const matchedObj = validObjects[0];
        const matchedKey = extractKeyFromS3Object(
          matchedObj.key,
          searchPrefix,
          compression.archiveFilename
        );

        const isExact = isExactKeyMatch(primaryKey, matchedKey);
        core.info(
          `S3 cache prefix hit: resolved key "${matchedKey}" using prefix "${restoreKey}" (${formatSize(matchedObj.size)})`
        );

        if (!lookupOnly) {
          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-'));
          const localArchive = path.join(tempDir, compression.archiveFilename);
          try {
            core.info(`Downloading cache archive from s3://${bucket}/${matchedObj.key}...`);
            await withRetry(() => downloadFile(client, bucket, matchedObj.key, localArchive), {
              retries: retryEnabled ? retryCount : 0,
              operationName: `downloadFile (${matchedObj.key})`,
            });

            core.info(`Extracting cache archive to working directory...`);
            await extractArchive(localArchive, compression);
            core.info(`Cache restored successfully from S3 key: ${matchedKey}`);
          } finally {
            try {
              fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {
              // Ignore cleanup error
            }
          }
        }

        return {
          matchedKey,
          isExactHit: isExact,
          s3ObjectKey: matchedObj.key,
          size: matchedObj.size,
          etag: matchedObj.etag,
        };
      }
    } catch (err) {
      core.warning(
        `Error querying S3 prefix "${searchPrefix}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return null;
}

export async function restoreImpl(
  stateProvider: IStateProvider,
  earlyExit?: boolean
): Promise<string | undefined> {
  try {
    if (!isValidEvent()) {
      core.warning(
        `Event Validation Warning: The event type ${process.env.GITHUB_EVENT_NAME} may not be tied to a branch or tag ref.`
      );
    }

    const primaryKey = core.getInput(Inputs.Key, { required: true });
    stateProvider.setState(State.CachePrimaryKey, primaryKey);
    core.setOutput(Outputs.CachePrimaryKey, primaryKey);

    const cachePaths = getInputAsArray(Inputs.Path, { required: true });
    const restoreKeys = getInputAsArray(Inputs.RestoreKeys);
    const failOnCacheMiss = getInputAsBool(Inputs.FailOnCacheMiss);
    const lookupOnly = getInputAsBool(Inputs.LookupOnly);
    const readOnly = getInputAsBool(Inputs.ReadOnly);
    const enableCrossOsArchive = getInputAsBool(Inputs.EnableCrossOsArchive);

    stateProvider.setState(State.CacheReadOnly, String(readOnly));

    const s3KeyPattern = core.getInput(Inputs.S3KeyPattern) || Defaults.DefaultS3KeyPattern;
    const prefix = core.getInput(Inputs.Prefix) || '';
    const scopedToRepository = getInputAsBool(Inputs.ScopedToRepository, true);
    const retryEnabled = getInputAsBool(Inputs.Retry, true);
    const retryCount = getInputAsInt(Inputs.RetryCount, Defaults.DefaultRetryCount) || 3;
    const useFallback = getInputAsBool(Inputs.UseFallback, false);

    // Dual-cache configuration
    const dualCache = getInputAsBool(Inputs.DualCache, false);
    const restorePriority =
      core.getInput(Inputs.RestorePriority) || Defaults.DefaultRestorePriority;
    const dualCacheStrategy =
      core.getInput(Inputs.DualCacheStrategy) || Defaults.DefaultDualCacheStrategy;
    const dualCacheStrict = getInputAsBool(Inputs.DualCacheStrict, false);

    // Persist configuration for post-save step
    stateProvider.setState(State.CacheS3KeyPattern, s3KeyPattern);
    stateProvider.setState(State.CachePrefix, prefix);
    stateProvider.setState(State.CacheScopedToRepository, String(scopedToRepository));
    stateProvider.setState(State.CacheRetry, String(retryEnabled));
    stateProvider.setState(State.CacheRetryCount, String(retryCount));
    stateProvider.setState(State.CacheDualCache, String(dualCache));
    stateProvider.setState(State.CacheRestorePriority, restorePriority);
    stateProvider.setState(State.CacheDualCacheStrategy, dualCacheStrategy);
    stateProvider.setState(State.CacheDualCacheStrict, String(dualCacheStrict));

    core.setOutput(Outputs.CacheHit, 'false');
    core.setOutput(Outputs.CacheHitSource, 'none');

    let storageContext: StorageContext | null = null;
    try {
      storageContext = createStorageContext({ maxAttempts: retryEnabled ? retryCount + 1 : 1 });
      core.setOutput(Outputs.CacheStorageProvider, storageContext.providerConfig.provider);
      stateProvider.setState(State.CacheStorageProvider, storageContext.providerConfig.provider);
    } catch (err: unknown) {
      if (useFallback || dualCache) {
        core.warning(
          `S3 client initialization failed: ${err instanceof Error ? err.message : String(err)}`
        );
      } else {
        throw err;
      }
    }

    const compression = await getCompressionConfig();

    const tryS3 = async (): Promise<S3RestoreResult | null> => {
      if (!storageContext) return null;
      return await restoreFromS3(
        storageContext,
        primaryKey,
        restoreKeys,
        s3KeyPattern,
        prefix,
        scopedToRepository,
        retryEnabled,
        retryCount,
        lookupOnly,
        compression
      );
    };

    const tryGitHub = async (): Promise<string | undefined> => {
      core.info('Querying GitHub Actions native cache service...');
      return await fallbackRestore(
        cachePaths,
        primaryKey,
        restoreKeys,
        { lookupOnly },
        enableCrossOsArchive
      );
    };

    let resolvedMatchedKey: string | undefined;
    let hitSource: 's3' | 'github' | 'none' = 'none';

    if (dualCache) {
      core.info(
        `Dual-caching enabled (priority: ${restorePriority}, strategy: ${dualCacheStrategy})`
      );

      if (restorePriority === 'github-first') {
        // 1. Try GitHub Cache first
        try {
          const ghKey = await tryGitHub();
          if (ghKey) {
            resolvedMatchedKey = ghKey;
            hitSource = 'github';
            if (isExactKeyMatch(primaryKey, ghKey)) {
              stateProvider.setState(State.CacheGithubExactHit, 'true');
            }
          }
        } catch (err) {
          if (dualCacheStrict) throw err;
          core.warning(
            `GitHub cache query error: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        // 2. Fallback to S3 if GitHub cache missed
        if (!resolvedMatchedKey && storageContext) {
          core.info('GitHub cache missed; querying S3 storage...');
          try {
            const s3Result = await tryS3();
            if (s3Result) {
              resolvedMatchedKey = s3Result.matchedKey;
              hitSource = 's3';
              if (s3Result.isExactHit) {
                stateProvider.setState(State.CacheS3ExactHit, 'true');
              }
              stateProvider.setState(State.CacheS3Key, s3Result.s3ObjectKey);
              core.setOutput(Outputs.CacheS3Key, s3Result.s3ObjectKey);
              core.setOutput(Outputs.CacheSize, s3Result.size.toString());
              if (s3Result.etag) core.setOutput(Outputs.CacheETag, s3Result.etag);
            }
          } catch (err) {
            if (dualCacheStrict) throw err;
            core.warning(
              `S3 cache query error: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      } else {
        // s3-first (default)
        // 1. Try S3 first
        if (storageContext) {
          try {
            const s3Result = await tryS3();
            if (s3Result) {
              resolvedMatchedKey = s3Result.matchedKey;
              hitSource = 's3';
              if (s3Result.isExactHit) {
                stateProvider.setState(State.CacheS3ExactHit, 'true');
              }
              stateProvider.setState(State.CacheS3Key, s3Result.s3ObjectKey);
              core.setOutput(Outputs.CacheS3Key, s3Result.s3ObjectKey);
              core.setOutput(Outputs.CacheSize, s3Result.size.toString());
              if (s3Result.etag) core.setOutput(Outputs.CacheETag, s3Result.etag);
            }
          } catch (err) {
            if (dualCacheStrict) throw err;
            core.warning(
              `S3 cache query error: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        // 2. Fallback to GitHub Cache if S3 missed
        if (!resolvedMatchedKey) {
          core.info('S3 storage missed; querying GitHub cache...');
          try {
            const ghKey = await tryGitHub();
            if (ghKey) {
              resolvedMatchedKey = ghKey;
              hitSource = 'github';
              if (isExactKeyMatch(primaryKey, ghKey)) {
                stateProvider.setState(State.CacheGithubExactHit, 'true');
              }
            }
          } catch (err) {
            if (dualCacheStrict) throw err;
            core.warning(
              `GitHub cache query error: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    } else {
      // Pure S3 Mode (standard)
      if (storageContext) {
        const s3Result = await tryS3();
        if (s3Result) {
          resolvedMatchedKey = s3Result.matchedKey;
          hitSource = 's3';
          if (s3Result.isExactHit) {
            stateProvider.setState(State.CacheS3ExactHit, 'true');
          }
          stateProvider.setState(State.CacheS3Key, s3Result.s3ObjectKey);
          core.setOutput(Outputs.CacheS3Key, s3Result.s3ObjectKey);
          core.setOutput(Outputs.CacheSize, s3Result.size.toString());
          if (s3Result.etag) core.setOutput(Outputs.CacheETag, s3Result.etag);
        }
      }

      // Standalone use-fallback option
      if (!resolvedMatchedKey && useFallback) {
        core.info('S3 cache missed; checking use-fallback GitHub cache...');
        const ghKey = await tryGitHub();
        if (ghKey) {
          resolvedMatchedKey = ghKey;
          hitSource = 'github';
        }
      }
    }

    stateProvider.setState(State.CacheHitSource, hitSource);
    core.setOutput(Outputs.CacheHitSource, hitSource);

    if (resolvedMatchedKey) {
      stateProvider.setState(State.CacheMatchedKey, resolvedMatchedKey);
      const isExact = isExactKeyMatch(primaryKey, resolvedMatchedKey);
      core.setOutput(Outputs.CacheHit, isExact.toString());
      core.setOutput(Outputs.CacheMatchedKey, resolvedMatchedKey);

      if (lookupOnly) {
        core.info(
          `Cache found from source "${hitSource}" and can be restored from key: ${resolvedMatchedKey}`
        );
      } else {
        core.info(
          `Cache restored successfully from source "${hitSource}" with key: ${resolvedMatchedKey}`
        );
      }

      return resolvedMatchedKey;
    }

    if (failOnCacheMiss) {
      throw new Error(
        `Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: ${primaryKey}`
      );
    }

    core.info(`Cache not found for input keys: ${[primaryKey, ...restoreKeys].join(', ')}`);
    return undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(message);
    if (earlyExit) {
      process.exit(1);
    }
  }
}

export async function runRestore(earlyExit = true): Promise<void> {
  await restoreImpl(new StateProvider(), earlyExit);
  if (earlyExit) {
    process.exit(0);
  }
}

export async function runRestoreOnly(earlyExit = true): Promise<void> {
  await restoreImpl(new NullStateProvider(), earlyExit);
  if (earlyExit) {
    process.exit(0);
  }
}
