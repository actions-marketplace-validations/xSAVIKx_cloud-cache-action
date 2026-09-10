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
import {
  buildS3ObjectKey,
  buildS3SearchPrefix,
  extractKeyFromS3Object,
} from '../utils/pathUtils';
import { createStorageContext } from '../storage/client';
import {
  checkObjectExists,
  listObjectsWithPrefix,
  downloadFile,
} from '../storage/operations';
import { withRetry } from '../storage/retry';
import { getCompressionConfig } from '../archive/compression';
import { extractArchive } from '../archive/tar';
import { fallbackRestore } from '../utils/fallback';

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

    stateProvider.setState(State.CacheReadOnly, String(readOnly));

    const s3KeyPattern = core.getInput(Inputs.S3KeyPattern) || Defaults.DefaultS3KeyPattern;
    const prefix = core.getInput(Inputs.Prefix) || '';
    const scopedToRepository = getInputAsBool(Inputs.ScopedToRepository, true);
    const retryEnabled = getInputAsBool(Inputs.Retry, true);
    const retryCount = getInputAsInt(Inputs.RetryCount, Defaults.DefaultRetryCount) || 3;
    const useFallback = getInputAsBool(Inputs.UseFallback, false);

    // Save configuration into state so post-run save step can reuse it
    stateProvider.setState(State.CacheS3KeyPattern, s3KeyPattern);
    stateProvider.setState(State.CachePrefix, prefix);
    stateProvider.setState(State.CacheScopedToRepository, String(scopedToRepository));
    stateProvider.setState(State.CacheRetry, String(retryEnabled));
    stateProvider.setState(State.CacheRetryCount, String(retryCount));

    core.setOutput(Outputs.CacheHit, 'false');

    let storageContext;
    try {
      storageContext = createStorageContext();
      core.setOutput(Outputs.CacheStorageProvider, storageContext.providerConfig.provider);
      stateProvider.setState(State.CacheStorageProvider, storageContext.providerConfig.provider);
    } catch (err: unknown) {
      if (useFallback) {
        core.warning(`S3 client initialization failed: ${err instanceof Error ? err.message : String(err)}`);
        return await handleFallbackRestore(cachePaths, primaryKey, restoreKeys, lookupOnly, failOnCacheMiss);
      }
      throw err;
    }

    const { client, bucket } = storageContext;
    const compression = await getCompressionConfig();

    const exactObjectKey = buildS3ObjectKey({
      key: primaryKey,
      prefix,
      archiveFilename: compression.archiveFilename,
      pattern: s3KeyPattern,
      scopedToRepository,
    });

    core.debug(`Checking exact S3 key match: ${exactObjectKey} in bucket: ${bucket}`);

    // Check exact match
    let exactObject = null;
    try {
      exactObject = await withRetry(
        () => checkObjectExists(client, bucket, exactObjectKey),
        {
          retries: retryEnabled ? retryCount : 0,
          operationName: `checkObjectExists (${exactObjectKey})`,
        }
      );
    } catch (err) {
      core.warning(`Error checking S3 cache object: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (exactObject) {
      core.info(`Exact cache hit on key: ${primaryKey} (${formatSize(exactObject.size)})`);
      stateProvider.setState(State.CacheMatchedKey, primaryKey);
      stateProvider.setState(State.CacheS3Key, exactObjectKey);

      core.setOutput(Outputs.CacheHit, 'true');
      core.setOutput(Outputs.CacheMatchedKey, primaryKey);
      core.setOutput(Outputs.CacheS3Key, exactObjectKey);
      core.setOutput(Outputs.CacheSize, exactObject.size.toString());
      if (exactObject.etag) {
        core.setOutput(Outputs.CacheETag, exactObject.etag);
      }

      if (lookupOnly) {
        core.info(`Cache found and can be restored from key: ${primaryKey} (lookup-only is enabled)`);
        return primaryKey;
      }

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-'));
      const localArchive = path.join(tempDir, compression.archiveFilename);

      try {
        core.info(`Downloading cache archive from s3://${bucket}/${exactObjectKey}...`);
        await withRetry(
          () => downloadFile(client, bucket, exactObjectKey, localArchive),
          {
            retries: retryEnabled ? retryCount : 0,
            operationName: `downloadFile (${exactObjectKey})`,
          }
        );

        core.info(`Extracting cache archive to working directory...`);
        await extractArchive(localArchive, compression);
        core.info(`Cache restored successfully from key: ${primaryKey}`);
        return primaryKey;
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup error
        }
      }
    }

    // Exact match was not found; search restore-keys
    core.debug(`Exact match not found. Searching restore keys: ${restoreKeys.join(', ')}`);

    for (const restoreKey of restoreKeys) {
      const searchPrefix = buildS3SearchPrefix(restoreKey, {
        prefix,
        pattern: s3KeyPattern,
        scopedToRepository,
      });

      core.debug(`Searching S3 objects with prefix: ${searchPrefix}`);

      try {
        const objects = await withRetry(
          () => listObjectsWithPrefix(client, bucket, searchPrefix),
          {
            retries: retryEnabled ? retryCount : 0,
            operationName: `listObjectsWithPrefix (${searchPrefix})`,
          }
        );

        // Filter objects containing archive filename extension
        const validObjects = objects.filter((o) =>
          o.key.endsWith(`/${compression.archiveFilename}`) ||
          o.key.endsWith(compression.archiveFilename)
        );

        if (validObjects.length > 0) {
          // Sort by LastModified descending
          validObjects.sort(
            (a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0)
          );

          const matchedObj = validObjects[0];
          const matchedKey = extractKeyFromS3Object(
            matchedObj.key,
            searchPrefix,
            compression.archiveFilename
          );

          core.info(`Cache prefix hit: resolved key "${matchedKey}" using prefix "${restoreKey}" (${formatSize(matchedObj.size)})`);

          stateProvider.setState(State.CacheMatchedKey, matchedKey);
          stateProvider.setState(State.CacheS3Key, matchedObj.key);

          const isExact = isExactKeyMatch(primaryKey, matchedKey);
          core.setOutput(Outputs.CacheHit, isExact.toString());
          core.setOutput(Outputs.CacheMatchedKey, matchedKey);
          core.setOutput(Outputs.CacheS3Key, matchedObj.key);
          core.setOutput(Outputs.CacheSize, matchedObj.size.toString());
          if (matchedObj.etag) {
            core.setOutput(Outputs.CacheETag, matchedObj.etag);
          }

          if (lookupOnly) {
            core.info(`Cache found and can be restored from key: ${matchedKey} (lookup-only is enabled)`);
            return matchedKey;
          }

          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-'));
          const localArchive = path.join(tempDir, compression.archiveFilename);

          try {
            core.info(`Downloading cache archive from s3://${bucket}/${matchedObj.key}...`);
            await withRetry(
              () => downloadFile(client, bucket, matchedObj.key, localArchive),
              {
                retries: retryEnabled ? retryCount : 0,
                operationName: `downloadFile (${matchedObj.key})`,
              }
            );

            core.info(`Extracting cache archive to working directory...`);
            await extractArchive(localArchive, compression);
            core.info(`Cache restored successfully from key: ${matchedKey}`);
            return matchedKey;
          } finally {
            try {
              fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {
              // Ignore cleanup error
            }
          }
        }
      } catch (err) {
        core.warning(
          `Error querying S3 prefix "${searchPrefix}": ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    // If S3 restore had no match, check fallback
    if (useFallback) {
      return await handleFallbackRestore(
        cachePaths,
        primaryKey,
        restoreKeys,
        lookupOnly,
        failOnCacheMiss
      );
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

async function handleFallbackRestore(
  cachePaths: string[],
  primaryKey: string,
  restoreKeys: string[],
  lookupOnly: boolean,
  failOnCacheMiss: boolean
): Promise<string | undefined> {
  const fallbackKey = await fallbackRestore(
    cachePaths,
    primaryKey,
    restoreKeys,
    { lookupOnly }
  );

  if (fallbackKey) {
    const isExact = isExactKeyMatch(primaryKey, fallbackKey);
    core.setOutput(Outputs.CacheHit, isExact.toString());
    core.setOutput(Outputs.CacheMatchedKey, fallbackKey);
    core.info(`Fallback cache restored successfully from key: ${fallbackKey}`);
    return fallbackKey;
  }

  if (failOnCacheMiss) {
    throw new Error(
      `Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: ${primaryKey}`
    );
  }

  core.info('Fallback cache restore did not find matching cache.');
  return undefined;
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
