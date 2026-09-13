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
import { buildS3ObjectKey } from '../utils/pathUtils';
import { createStorageContext, StorageContext } from '../storage/client';
import { checkObjectExists, uploadFile } from '../storage/operations';
import { withRetry } from '../storage/retry';
import { getCompressionConfig, CompressionConfig } from '../archive/compression';
import { createArchive, getArchiveSize } from '../archive/tar';
import { getWorkspace } from '../archive/paths';
import { fallbackSave } from '../utils/fallback';

// Prevent unhandled rejection leaks from failing the workflow
process.on('uncaughtException', (err) => {
  core.warning(
    `Unhandled cache save exception: ${err instanceof Error ? err.message : String(err)}`
  );
});

export async function saveToS3(
  storageContext: StorageContext,
  primaryKey: string,
  cachePaths: string[],
  s3KeyPattern: string,
  prefix: string,
  scopedToRepository: boolean,
  retryEnabled: boolean,
  retryCount: number,
  uploadChunkSize: number | undefined,
  enableCrossOsArchive: boolean,
  compression: CompressionConfig
): Promise<{ size: number; s3ObjectKey: string; etag?: string }> {
  const { client, bucket } = storageContext;

  const s3ObjectKey = buildS3ObjectKey({
    key: primaryKey,
    prefix,
    archiveFilename: compression.archiveFilename,
    pattern: s3KeyPattern,
    scopedToRepository,
  });

  core.debug(`Target S3 key for save: ${s3ObjectKey} in bucket: ${bucket}`);

  // Check if object already exists in S3 (e.g. concurrent race)
  try {
    const existing = await checkObjectExists(client, bucket, s3ObjectKey);
    if (existing) {
      core.info(`Cache object already exists at "${s3ObjectKey}". Skipping upload.`);
      return {
        size: existing.size,
        s3ObjectKey,
        etag: existing.etag,
      };
    }
  } catch (err) {
    core.debug(`Object existence check error: ${err}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-save-'));
  const localArchive = path.join(tempDir, compression.archiveFilename);

  try {
    core.info(`Creating cache archive for paths: ${cachePaths.join(', ')}...`);
    await createArchive(localArchive, cachePaths, compression, getWorkspace());

    const archiveSize = getArchiveSize(localArchive);
    core.info(
      `Archive created successfully. Size: ${formatSize(archiveSize)} (${archiveSize} bytes)`
    );

    core.info(`Uploading cache archive to s3://${bucket}/${s3ObjectKey}...`);
    const uploadResult = await withRetry(
      () => uploadFile(client, bucket, s3ObjectKey, localArchive, uploadChunkSize),
      {
        retries: retryEnabled ? retryCount : 0,
        operationName: `uploadFile (${s3ObjectKey})`,
      }
    );

    core.info(`Cache saved to S3 successfully with key: ${primaryKey}`);
    return {
      size: uploadResult.size,
      s3ObjectKey,
      etag: uploadResult.etag,
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}

export async function saveImpl(stateProvider: IStateProvider): Promise<number | void> {
  try {
    if (!isValidEvent()) {
      core.warning(
        `Event Validation Warning: The event type ${process.env.GITHUB_EVENT_NAME} may not be tied to a branch or tag ref.`
      );
    }

    const readOnlyState = stateProvider.getState(State.CacheReadOnly);
    const readOnly = readOnlyState === 'true' || getInputAsBool(Inputs.ReadOnly);

    if (readOnly) {
      core.info('Read-only mode enabled. Skipping cache save.');
      return;
    }

    const primaryKey = stateProvider.getState(State.CachePrimaryKey) || core.getInput(Inputs.Key);

    if (!primaryKey) {
      core.warning('Key is not specified. Skipping cache save.');
      return;
    }

    const cachePaths = getInputAsArray(Inputs.Path, { required: true });
    if (cachePaths.length === 0) {
      core.warning('No paths specified to cache. Skipping save.');
      return;
    }

    const s3KeyPattern =
      stateProvider.getState(State.CacheS3KeyPattern) ||
      core.getInput(Inputs.S3KeyPattern) ||
      Defaults.DefaultS3KeyPattern;
    const prefix = stateProvider.getState(State.CachePrefix) || core.getInput(Inputs.Prefix) || '';
    const scopedToRepoState = stateProvider.getState(State.CacheScopedToRepository);
    const scopedToRepository =
      scopedToRepoState !== ''
        ? scopedToRepoState === 'true'
        : getInputAsBool(Inputs.ScopedToRepository, true);

    const retryState = stateProvider.getState(State.CacheRetry);
    const retryEnabled =
      retryState !== '' ? retryState === 'true' : getInputAsBool(Inputs.Retry, true);
    const retryCountState = stateProvider.getState(State.CacheRetryCount);
    const retryCount =
      Number(retryCountState) || getInputAsInt(Inputs.RetryCount, Defaults.DefaultRetryCount) || 3;

    const uploadChunkSize = getInputAsInt(Inputs.UploadChunkSize);
    const enableCrossOsArchive = getInputAsBool(Inputs.EnableCrossOsArchive);
    const useFallback = getInputAsBool(Inputs.UseFallback, false);

    // Dual-cache configuration and restore states
    const dualCacheState = stateProvider.getState(State.CacheDualCache);
    const dualCache =
      dualCacheState !== '' ? dualCacheState === 'true' : getInputAsBool(Inputs.DualCache, false);
    const dualCacheStrategy =
      stateProvider.getState(State.CacheDualCacheStrategy) ||
      core.getInput(Inputs.DualCacheStrategy) ||
      Defaults.DefaultDualCacheStrategy;
    const dualCacheStrictState = stateProvider.getState(State.CacheDualCacheStrict);
    const dualCacheStrict =
      dualCacheStrictState !== ''
        ? dualCacheStrictState === 'true'
        : getInputAsBool(Inputs.DualCacheStrict, false);

    const s3ExactHit = stateProvider.getState(State.CacheS3ExactHit) === 'true';
    const ghExactHit = stateProvider.getState(State.CacheGithubExactHit) === 'true';
    const restoredKey = stateProvider.getCacheState();

    let storageContext: StorageContext | null = null;
    try {
      storageContext = createStorageContext({ maxAttempts: retryEnabled ? retryCount + 1 : 1 });
      core.setOutput(Outputs.CacheStorageProvider, storageContext.providerConfig.provider);
    } catch (err: unknown) {
      if (useFallback || dualCache) {
        core.warning(
          `S3 client initialization failed during save: ${err instanceof Error ? err.message : String(err)}`
        );
      } else {
        throw err;
      }
    }

    const compression = await getCompressionConfig();
    const savedSources: string[] = [];

    if (dualCache) {
      core.info(`Dual-cache save executing (strategy: ${dualCacheStrategy})`);

      // Determine S3 save necessity
      let shouldSaveS3 = true;
      if (s3ExactHit) {
        core.info(`Exact hit already occurred in S3 for key "${primaryKey}", skipping S3 save.`);
        shouldSaveS3 = false;
        savedSources.push('s3');
      } else if (dualCacheStrategy === 'skip-on-hit' && (s3ExactHit || ghExactHit)) {
        core.info('Cache hit occurred on another tier; strategy is skip-on-hit, skipping S3 save.');
        shouldSaveS3 = false;
      }

      // Determine GitHub Cache save necessity
      let shouldSaveGH = true;
      if (ghExactHit) {
        core.info(
          `Exact hit already occurred in GitHub Cache for key "${primaryKey}", skipping GitHub save.`
        );
        shouldSaveGH = false;
        savedSources.push('github');
      } else if (dualCacheStrategy === 'skip-on-hit' && (s3ExactHit || ghExactHit)) {
        core.info(
          'Cache hit occurred on another tier; strategy is skip-on-hit, skipping GitHub save.'
        );
        shouldSaveGH = false;
      }

      // 1. Save to S3 if needed
      if (shouldSaveS3 && storageContext) {
        try {
          core.info(`Saving/backfilling cache to S3...`);
          const s3Res = await saveToS3(
            storageContext,
            primaryKey,
            cachePaths,
            s3KeyPattern,
            prefix,
            scopedToRepository,
            retryEnabled,
            retryCount,
            uploadChunkSize,
            enableCrossOsArchive,
            compression
          );
          savedSources.push('s3');
          core.setOutput(Outputs.CacheS3Key, s3Res.s3ObjectKey);
          core.setOutput(Outputs.CacheSize, s3Res.size.toString());
          if (s3Res.etag) core.setOutput(Outputs.CacheETag, s3Res.etag);
        } catch (err) {
          if (dualCacheStrict) throw err;
          core.warning(
            `Dual-cache S3 save error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // 2. Save to GitHub Cache if needed
      if (shouldSaveGH) {
        try {
          core.info(`Saving/backfilling cache to GitHub Actions Cache...`);
          const ghRes = await fallbackSave(
            cachePaths,
            primaryKey,
            { uploadChunkSize },
            enableCrossOsArchive
          );
          if (ghRes !== undefined) {
            savedSources.push('github');
          }
        } catch (err) {
          if (dualCacheStrict) throw err;
          core.warning(
            `Dual-cache GitHub save error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      const finalSaved = Array.from(new Set(savedSources));
      core.setOutput(Outputs.CacheSavedSources, finalSaved.join(',') || 'none');
      core.info(
        `Dual-cache save complete. Active cache sources: ${finalSaved.join(', ') || 'none'}`
      );
      return;
    }

    // Standard Pure-S3 Save
    if (restoredKey && isExactKeyMatch(primaryKey, restoredKey)) {
      core.info(`Cache hit occurred on primary key "${primaryKey}", not saving cache.`);
      core.setOutput(Outputs.CacheSavedSources, 'none');
      return;
    }

    if (storageContext) {
      try {
        const s3Res = await saveToS3(
          storageContext,
          primaryKey,
          cachePaths,
          s3KeyPattern,
          prefix,
          scopedToRepository,
          retryEnabled,
          retryCount,
          uploadChunkSize,
          enableCrossOsArchive,
          compression
        );
        core.setOutput(Outputs.CacheS3Key, s3Res.s3ObjectKey);
        core.setOutput(Outputs.CacheSize, s3Res.size.toString());
        core.setOutput(Outputs.CacheSavedSources, 's3');
        if (s3Res.etag) core.setOutput(Outputs.CacheETag, s3Res.etag);
        return s3Res.size;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (useFallback) {
          core.warning(`S3 save failed: ${msg}. Attempting fallback save to GitHub...`);
          await fallbackSave(cachePaths, primaryKey, { uploadChunkSize }, enableCrossOsArchive);
          core.setOutput(Outputs.CacheSavedSources, 'github');
        } else {
          core.warning(`Failed to save cache to S3: ${msg}`);
          core.setOutput(Outputs.CacheSavedSources, 'none');
        }
      }
    } else if (useFallback) {
      await fallbackSave(cachePaths, primaryKey, { uploadChunkSize }, enableCrossOsArchive);
      core.setOutput(Outputs.CacheSavedSources, 'github');
    }
  } catch (err: unknown) {
    core.warning(
      `Save cache encountered error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function runSave(earlyExit = true): Promise<void> {
  await saveImpl(new StateProvider());
  if (earlyExit) {
    process.exit(0);
  }
}

export async function runSaveOnly(earlyExit = true): Promise<void> {
  await saveImpl(new NullStateProvider());
  if (earlyExit) {
    process.exit(0);
  }
}
