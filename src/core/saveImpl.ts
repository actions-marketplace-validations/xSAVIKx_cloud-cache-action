import * as core from '@actions/core';
import { Outputs, State } from '../constants';
import { NullStateProvider, StateProvider, type IStateProvider } from '../state';
import { isValidEvent } from '../utils/inputUtils';
import { readCacheConfig, type CacheConfig } from './config';
import { existsInGitHub, saveToGitHub } from './githubTier';
import { toError, type S3ObjectInfo } from './outcomes';
import { buildS3Tier, saveToS3, type S3Tier } from './s3Tier';

function reportS3(info: S3ObjectInfo | undefined): void {
  if (!info) {
    return;
  }
  core.setOutput(Outputs.CacheS3Key, info.objectKey);
  core.setOutput(Outputs.CacheSize, String(info.size));
  if (info.etag) {
    core.setOutput(Outputs.CacheETag, info.etag);
  }
}

async function setUpS3(config: CacheConfig): Promise<S3Tier | undefined> {
  try {
    const tier = await buildS3Tier(config);
    core.setOutput(Outputs.CacheStorageProvider, tier.storage.providerConfig.provider);
    return tier;
  } catch (err) {
    const otherTierMayServe = config.dualCache ? !config.dualCacheStrict : config.useFallback;
    if (!otherTierMayServe) {
      throw err;
    }
    core.warning(`S3 client initialization failed during save: ${toError(err).message}`);
    return undefined;
  }
}

async function saveSingleTier(
  config: CacheConfig,
  s3: S3Tier | undefined,
  s3ExactHit: boolean
): Promise<number | void> {
  if (s3ExactHit) {
    core.info(`Cache hit occurred on the primary key ${config.primaryKey}, not saving cache.`);
    core.setOutput(Outputs.CacheSavedSources, 'none');
    return;
  }

  if (s3) {
    const outcome = await saveToS3(s3, config.primaryKey, config.paths, config.uploadChunkSize);
    if (outcome.kind === 'saved' || outcome.kind === 'exists') {
      reportS3(outcome.s3);
      core.setOutput(Outputs.CacheSavedSources, 's3');
      return outcome.s3?.size;
    }
    if (outcome.kind === 'skipped') {
      core.setOutput(Outputs.CacheSavedSources, 'none');
      return;
    }
    core.warning(`Failed to save cache to S3: ${outcome.error.message}`);
  }

  if (config.useFallback) {
    core.info('Saving to GitHub Actions Cache instead (use-fallback).');
    const outcome = await saveToGitHub(
      config.paths,
      config.primaryKey,
      config.uploadChunkSize,
      config.enableCrossOsArchive
    );
    if (outcome.kind === 'saved') {
      core.setOutput(Outputs.CacheSavedSources, 'github');
      return;
    }
    if (outcome.kind === 'error') {
      core.warning(`Failed to save cache to GitHub Actions Cache: ${outcome.error.message}`);
    }
  }
  core.setOutput(Outputs.CacheSavedSources, 'none');
}

async function saveBothTiers(
  config: CacheConfig,
  s3: S3Tier | undefined,
  s3ExactHit: boolean,
  githubExactHit: boolean
): Promise<void> {
  const present = new Set<'s3' | 'github'>();
  const tierFailed = (tier: string, error: Error): void => {
    if (config.dualCacheStrict) {
      throw new Error(`Saving to ${tier} failed: ${error.message}`);
    }
    core.warning(`Dual-cache ${tier} save error: ${error.message}`);
  };

  core.info(`Dual-cache save (strategy: ${config.dualCacheStrategy})`);
  const skipBoth = config.dualCacheStrategy === 'skip-on-hit' && (s3ExactHit || githubExactHit);
  if (skipBoth) {
    core.info(
      'An exact hit occurred on one tier and dual-cache-strategy is skip-on-hit; not saving.'
    );
  }

  if (s3ExactHit) {
    present.add('s3');
  } else if (!skipBoth && s3) {
    const outcome = await saveToS3(s3, config.primaryKey, config.paths, config.uploadChunkSize);
    if (outcome.kind === 'saved' || outcome.kind === 'exists') {
      present.add('s3');
      reportS3(outcome.s3);
    } else if (outcome.kind === 'error') {
      tierFailed('S3', outcome.error);
    }
  }

  if (githubExactHit) {
    present.add('github');
  } else if (!skipBoth) {
    let alreadyThere = false;
    try {
      alreadyThere = await existsInGitHub(
        config.paths,
        config.primaryKey,
        config.enableCrossOsArchive
      );
    } catch (err) {
      tierFailed('GitHub Actions Cache', toError(err));
    }
    if (alreadyThere) {
      core.info(
        `GitHub Actions Cache already has key "${config.primaryKey}"; not uploading it again.`
      );
      present.add('github');
    } else {
      const outcome = await saveToGitHub(
        config.paths,
        config.primaryKey,
        config.uploadChunkSize,
        config.enableCrossOsArchive
      );
      if (outcome.kind === 'saved') {
        present.add('github');
      } else if (outcome.kind === 'error') {
        tierFailed('GitHub Actions Cache', outcome.error);
      }
    }
  }

  const sources = (['s3', 'github'] as const).filter((source) => present.has(source));
  core.setOutput(Outputs.CacheSavedSources, sources.join(',') || 'none');
  core.info(`Dual-cache save complete. Cache present in: ${sources.join(', ') || 'none'}`);
}

export async function saveImpl(stateProvider: IStateProvider): Promise<number | void> {
  let strict = false;
  try {
    if (!isValidEvent()) {
      core.warning(
        `Event Validation Warning: The event type ${process.env.GITHUB_EVENT_NAME} may not be tied to a branch or tag ref.`
      );
    }

    const config = readCacheConfig(stateProvider);
    strict = config.dualCache && config.dualCacheStrict;
    if (config.readOnly) {
      core.info('Read-only mode enabled. Skipping cache save.');
      return;
    }
    if (!config.primaryKey) {
      core.warning('Key is not specified. Skipping cache save.');
      return;
    }
    if (config.paths.length === 0) {
      core.warning('No paths specified to cache. Skipping save.');
      return;
    }

    const s3ExactHit = stateProvider.getState(State.CacheS3ExactHit) === 'true';
    const githubExactHit = stateProvider.getState(State.CacheGithubExactHit) === 'true';
    const s3 = await setUpS3(config);

    if (config.dualCache) {
      await saveBothTiers(config, s3, s3ExactHit, githubExactHit);
      return;
    }
    return await saveSingleTier(config, s3, s3ExactHit);
  } catch (err) {
    const message = toError(err).message;
    if (strict) {
      core.setFailed(message);
    } else {
      core.warning(`Save cache encountered error: ${message}`);
    }
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
