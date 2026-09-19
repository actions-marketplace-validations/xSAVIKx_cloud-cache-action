import * as core from '@actions/core';
import { getWorkspace } from '../archive/paths';
import { Outputs, State } from '../constants';
import { NullStateProvider, StateProvider, type IStateProvider } from '../state';
import { isValidEvent } from '../utils/inputUtils';
import { readCacheConfig, type CacheConfig } from './config';
import { existsInGitHub, saveToGitHub } from './githubTier';
import { emitMetrics, type StepMetrics } from './metrics';
import { toError, type S3ObjectInfo } from './outcomes';
import { buildS3Tier, saveToS3, type S3Tier } from './s3Tier';
import { writeSaveSummary } from './summary';

/** What got saved where, so the caller can build the job summary and its own return value. */
interface SaveResult {
  size?: number;
  sources: Array<'s3' | 'github'>;
  /** The S3 object this step wrote or found, for the metrics line. */
  objectKey?: string;
  /** The S3 upload alone, when one happened. */
  transferMs?: number;
  /** How the step ended, as the metrics line reports it. */
  outcome: Extract<StepMetrics['outcome'], 'saved' | 'exists' | 'skipped' | 'error'>;
  /** A tier error that was warned away rather than thrown, when nothing was saved. */
  error?: string;
}

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

async function setUpS3(
  config: CacheConfig,
  stateProvider: IStateProvider
): Promise<S3Tier | undefined> {
  try {
    const tier = await buildS3Tier(config, process.env, {
      compression: stateProvider.getState(State.CacheCompression),
    });
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
): Promise<SaveResult> {
  if (s3ExactHit) {
    core.info(`Cache hit occurred on the primary key ${config.primaryKey}, not saving cache.`);
    core.setOutput(Outputs.CacheSavedSources, 'none');
    return { sources: [], outcome: 'exists' };
  }

  // A tier error the step only warned about still makes the outcome an error, not a plain skip.
  let warnedError: string | undefined;
  if (s3) {
    const outcome = await saveToS3(s3, config.primaryKey, config.paths, config.uploadChunkSize);
    switch (outcome.kind) {
      case 'saved':
      case 'exists':
        reportS3(outcome.s3);
        core.setOutput(Outputs.CacheSavedSources, 's3');
        return {
          size: outcome.s3?.size,
          sources: ['s3'],
          objectKey: outcome.s3?.objectKey,
          transferMs: outcome.transferMs,
          outcome: outcome.kind,
        };
      case 'skipped':
        core.setOutput(Outputs.CacheSavedSources, 'none');
        return { sources: [], outcome: 'skipped' };
      case 'error':
        core.warning(`Failed to save cache to S3: ${outcome.error.message}`);
        warnedError = outcome.error.message;
        break;
      default: {
        const unreachable: never = outcome;
        throw new Error(`Unhandled save outcome: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  if (config.useFallback) {
    core.info('Saving to GitHub Actions Cache instead (use-fallback).');
    const outcome = await saveToGitHub(
      config.paths,
      config.primaryKey,
      config.uploadChunkSize,
      config.enableCrossOsArchive
    );
    switch (outcome.kind) {
      case 'saved':
        core.setOutput(Outputs.CacheSavedSources, 'github');
        return { sources: ['github'], outcome: 'saved' };
      case 'error':
        core.warning(`Failed to save cache to GitHub Actions Cache: ${outcome.error.message}`);
        warnedError = outcome.error.message;
        break;
      case 'exists':
      case 'skipped':
        break;
      default: {
        const unreachable: never = outcome;
        throw new Error(`Unhandled save outcome: ${JSON.stringify(unreachable)}`);
      }
    }
  }
  core.setOutput(Outputs.CacheSavedSources, 'none');
  return warnedError
    ? { sources: [], outcome: 'error', error: warnedError }
    : { sources: [], outcome: 'skipped' };
}

async function saveBothTiers(
  config: CacheConfig,
  s3: S3Tier | undefined,
  s3ExactHit: boolean,
  githubExactHit: boolean
): Promise<SaveResult> {
  const present = new Set<'s3' | 'github'>();
  let size: number | undefined;
  let objectKey: string | undefined;
  let transferMs: number | undefined;
  // Only an upload this step actually performed makes the outcome "saved"; tiers that already
  // held the key report "exists".
  let uploaded = false;
  // A tier error the step only warned about still makes the outcome an error, not a plain skip.
  let warnedError: string | undefined;
  const tierFailed = (tier: string, error: Error): void => {
    if (config.dualCacheStrict) {
      throw new Error(`Saving to ${tier} failed: ${error.message}`, { cause: error });
    }
    core.warning(`Dual-cache ${tier} save error: ${error.message}`);
    warnedError = error.message;
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
    switch (outcome.kind) {
      case 'saved':
      case 'exists':
        present.add('s3');
        reportS3(outcome.s3);
        size = outcome.s3?.size;
        objectKey = outcome.s3?.objectKey;
        transferMs = outcome.transferMs;
        uploaded ||= outcome.kind === 'saved';
        break;
      case 'skipped':
        break;
      case 'error':
        tierFailed('S3', outcome.error);
        break;
      default: {
        const unreachable: never = outcome;
        throw new Error(`Unhandled save outcome: ${JSON.stringify(unreachable)}`);
      }
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
      switch (outcome.kind) {
        case 'saved':
          present.add('github');
          uploaded = true;
          break;
        case 'error':
          tierFailed('GitHub Actions Cache', outcome.error);
          break;
        case 'exists':
        case 'skipped':
          break;
        default: {
          const unreachable: never = outcome;
          throw new Error(`Unhandled save outcome: ${JSON.stringify(unreachable)}`);
        }
      }
    }
  }

  const sources = (['s3', 'github'] as const).filter((source) => present.has(source));
  core.setOutput(Outputs.CacheSavedSources, sources.join(',') || 'none');
  core.info(`Dual-cache save complete. Cache present in: ${sources.join(', ') || 'none'}`);
  if (sources.length === 0) {
    return warnedError
      ? { sources: [], objectKey, transferMs, outcome: 'error', error: warnedError }
      : { sources: [], objectKey, transferMs, outcome: 'skipped' };
  }
  return {
    size,
    sources: [...sources],
    objectKey,
    transferMs,
    outcome: uploaded ? 'saved' : 'exists',
  };
}

export async function saveImpl(stateProvider: IStateProvider): Promise<number | void> {
  let strict = false;
  const start = Date.now();
  let config: CacheConfig | undefined;
  let provider: string | undefined;
  // One line per step: a throw after the save has already reported must not report twice.
  let reported = false;
  const report = (metrics: Omit<StepMetrics, 'timestamp' | 'durationMs'>): void => {
    if (reported) {
      return;
    }
    reported = true;
    emitMetrics(
      { ...metrics, timestamp: new Date().toISOString(), durationMs: Date.now() - start },
      config?.metricsFile ?? '',
      getWorkspace()
    );
  };
  try {
    if (!isValidEvent()) {
      core.warning(
        `Event Validation Warning: The event type ${process.env.GITHUB_EVENT_NAME} may not be tied to a branch or tag ref.`
      );
    }

    config = readCacheConfig(stateProvider);
    strict = config.dualCache && config.dualCacheStrict;
    // Set up front and overwritten on success, so every path — an early skip or an error
    // handled as a warning included — leaves the timing and size outputs defined.
    core.setOutput(Outputs.CacheSaveDurationMs, '0');
    core.setOutput(Outputs.CacheTransferDurationMs, '0');
    core.setOutput(Outputs.CacheBytes, '0');
    /** Records a save that never reached the tiers, so the metrics file still gets its line. */
    const skip = (reason: string): void => {
      report({
        step: 'save',
        key: config?.primaryKey,
        savedTo: [],
        bytes: 0,
        outcome: 'skipped',
        extra: { reason },
      });
    };
    if (config.readOnly) {
      core.info('Read-only mode enabled. Skipping cache save.');
      skip('read-only');
      return;
    }
    if (!config.primaryKey) {
      core.warning('Key is not specified. Skipping cache save.');
      skip('no key');
      return;
    }
    if (config.paths.length === 0) {
      core.warning('No paths specified to cache. Skipping save.');
      skip('no paths');
      return;
    }

    const s3ExactHit = stateProvider.getState(State.CacheS3ExactHit) === 'true';
    const githubExactHit = stateProvider.getState(State.CacheGithubExactHit) === 'true';
    const s3 = await setUpS3(config, stateProvider);
    provider = s3?.storage.providerConfig.provider;

    const result = config.dualCache
      ? await saveBothTiers(config, s3, s3ExactHit, githubExactHit)
      : await saveSingleTier(config, s3, s3ExactHit);
    core.setOutput(Outputs.CacheSaveDurationMs, String(Date.now() - start));
    core.setOutput(Outputs.CacheTransferDurationMs, String(result.transferMs ?? 0));
    core.setOutput(Outputs.CacheBytes, String(result.size ?? 0));
    report({
      step: 'save',
      provider,
      key: config.primaryKey,
      objectKey: result.objectKey,
      savedTo: result.sources,
      bytes: result.size ?? 0,
      transferDurationMs: result.transferMs ?? 0,
      streaming: config.streaming,
      outcome: result.outcome,
      extra: result.error ? { error: result.error } : undefined,
    });
    await writeSaveSummary({
      jobSummary: config.jobSummary,
      key: config.primaryKey,
      savedTo: result.sources,
      size: result.size,
      durationMs: Date.now() - start,
    });
    return config.dualCache ? undefined : result.size;
  } catch (err) {
    const message = toError(err).message;
    report({
      step: 'save',
      provider,
      key: config?.primaryKey,
      savedTo: [],
      bytes: 0,
      outcome: 'error',
      extra: { error: message },
    });
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
    // An explicit exit code overrides process.exitCode, so keep the one core.setFailed set.
    process.exit(process.exitCode ?? 0);
  }
}

export async function runSaveOnly(earlyExit = true): Promise<void> {
  await saveImpl(new NullStateProvider());
  if (earlyExit) {
    // An explicit exit code overrides process.exitCode, so keep the one core.setFailed set.
    process.exit(process.exitCode ?? 0);
  }
}
