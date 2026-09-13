import * as core from '@actions/core';
import { Outputs, State } from '../constants';
import { NullStateProvider, StateProvider, type IStateProvider } from '../state';
import { isValidEvent } from '../utils/inputUtils';
import { persistCacheConfig, readCacheConfig, type CacheConfig } from './config';
import { restoreFromGitHub } from './githubTier';
import { toError, type RestoreOutcome } from './outcomes';
import { buildS3Tier, restoreFromS3, type S3Tier } from './s3Tier';

type Source = 's3' | 'github';
type Hit = Extract<RestoreOutcome, { kind: 'hit' }>;

/** S3 alone, unless use-fallback or dual-cache adds GitHub Actions Cache. */
function restoreOrder(config: CacheConfig): Source[] {
  if (config.dualCache) {
    return config.restorePriority === 'github-first' ? ['github', 's3'] : ['s3', 'github'];
  }
  return config.useFallback ? ['s3', 'github'] : ['s3'];
}

/** S3 setup errors fail the step only when no other tier may serve the restore. */
async function setUpS3(config: CacheConfig, state: IStateProvider): Promise<S3Tier | undefined> {
  try {
    const tier = await buildS3Tier(config);
    core.setOutput(Outputs.CacheStorageProvider, tier.storage.providerConfig.provider);
    state.setState(State.CacheStorageProvider, tier.storage.providerConfig.provider);
    // The post step reuses this method, so zstd appearing mid-job cannot change the keys.
    state.setState(State.CacheCompression, tier.compression.method);
    return tier;
  } catch (err) {
    const otherTierMayServe = config.dualCache ? !config.dualCacheStrict : config.useFallback;
    if (!otherTierMayServe) {
      throw err;
    }
    core.warning(`S3 client initialization failed: ${toError(err).message}`);
    return undefined;
  }
}

async function attempt(
  source: Source,
  config: CacheConfig,
  s3: S3Tier | undefined
): Promise<RestoreOutcome> {
  if (source === 'github') {
    core.info('Querying GitHub Actions Cache...');
    return restoreFromGitHub(
      config.paths,
      config.primaryKey,
      config.restoreKeys,
      config.lookupOnly,
      config.enableCrossOsArchive
    );
  }
  if (!s3) {
    return { kind: 'miss' };
  }
  return restoreFromS3(s3, config.primaryKey, config.restoreKeys, config.lookupOnly);
}

function reportHit(state: IStateProvider, config: CacheConfig, source: Source, hit: Hit): string {
  state.setState(State.CacheMatchedKey, hit.matchedKey);
  state.setState(State.CacheHitSource, source);
  if (hit.exact) {
    state.setState(source === 's3' ? State.CacheS3ExactHit : State.CacheGithubExactHit, 'true');
  }
  if (hit.s3) {
    state.setState(State.CacheS3Key, hit.s3.objectKey);
    core.setOutput(Outputs.CacheS3Key, hit.s3.objectKey);
    core.setOutput(Outputs.CacheSize, String(hit.s3.size));
    if (hit.s3.etag) {
      core.setOutput(Outputs.CacheETag, hit.s3.etag);
    }
  }
  core.setOutput(Outputs.CacheHit, String(hit.exact));
  core.setOutput(Outputs.CacheMatchedKey, hit.matchedKey);
  core.setOutput(Outputs.CacheHitSource, source);
  core.info(
    config.lookupOnly
      ? `Cache found in ${source} and can be restored from key: ${hit.matchedKey}`
      : `Cache restored from ${source} with key: ${hit.matchedKey}`
  );
  return hit.matchedKey;
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

    const config = readCacheConfig();
    if (!config.primaryKey) {
      throw new Error('Input required and not supplied: key');
    }
    if (config.paths.length === 0) {
      throw new Error('Input required and not supplied: path');
    }

    persistCacheConfig(stateProvider, config);
    core.setOutput(Outputs.CachePrimaryKey, config.primaryKey);
    core.setOutput(Outputs.CacheHit, 'false');
    core.setOutput(Outputs.CacheHitSource, 'none');

    const s3 = await setUpS3(config, stateProvider);
    if (config.dualCache) {
      core.info(
        `Dual-cache enabled (priority: ${config.restorePriority}, strategy: ${config.dualCacheStrategy})`
      );
    }

    for (const source of restoreOrder(config)) {
      const outcome = await attempt(source, config, s3);
      if (outcome.kind === 'hit') {
        return reportHit(stateProvider, config, source, outcome);
      }
      if (outcome.kind === 'error') {
        if (config.dualCache && config.dualCacheStrict) {
          throw new Error(`Restoring from ${source} failed: ${outcome.error.message}`);
        }
        core.warning(
          `Restoring from ${source} failed, so it counts as a cache miss: ${outcome.error.message}`
        );
      }
    }

    stateProvider.setState(State.CacheHitSource, 'none');
    if (config.failOnCacheMiss) {
      throw new Error(
        `Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: ${config.primaryKey}`
      );
    }
    core.info(
      `Cache not found for input keys: ${[config.primaryKey, ...config.restoreKeys].join(', ')}`
    );
    return undefined;
  } catch (err) {
    core.setFailed(toError(err).message);
    if (earlyExit) {
      process.exit(1);
    }
    return undefined;
  }
}

export async function runRestore(earlyExit = true): Promise<void> {
  await restoreImpl(new StateProvider(), earlyExit);
  if (earlyExit) {
    // An explicit exit code overrides process.exitCode, so keep the one core.setFailed set.
    process.exit(process.exitCode ?? 0);
  }
}

export async function runRestoreOnly(earlyExit = true): Promise<void> {
  await restoreImpl(new NullStateProvider(), earlyExit);
  if (earlyExit) {
    // An explicit exit code overrides process.exitCode, so keep the one core.setFailed set.
    process.exit(process.exitCode ?? 0);
  }
}
