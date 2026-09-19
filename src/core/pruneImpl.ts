import * as core from '@actions/core';
import { getWorkspace } from '../archive/paths';
import { Defaults, Inputs, Outputs } from '../constants';
import { createStorageContext } from '../storage/client';
import { getInputAsBool, getInputAsInt, parsePositiveInt } from '../utils/inputUtils';
import { compileKeyTemplate } from './keyTemplate';
import { emitMetrics } from './metrics';
import { toError } from './outcomes';
import { pruneCaches, type PruneTier } from './prune';

const TRUE_VALUES = ['true', 'True', 'TRUE'];
const FALSE_VALUES = ['false', 'False', 'FALSE'];

/** Every input the prune step reads. `ref` empty means every ref. */
export interface PruneConfig {
  olderThanDays: number;
  ref: string;
  dryRun: boolean;
  prefix: string;
  s3KeyPattern: string;
  scopedToRepository: boolean;
  scopedToRef: boolean;
  retryEnabled: boolean;
  retryCount: number;
  /** Workspace-relative file that gets one JSON line of metrics; '' disables it. */
  metricsFile: string;
}

/**
 * Unlike `getInputAsBool`, which warns and falls back to a default on an unrecognized value,
 * an unrecognized `dry-run` value must fail the step: silently treating it as `false` would
 * turn a typo (e.g. "Flase") into a real, unintended deletion.
 */
function parseDryRun(raw: string): boolean {
  if (raw === '') {
    return false;
  }
  if (TRUE_VALUES.includes(raw)) {
    return true;
  }
  if (FALSE_VALUES.includes(raw)) {
    return false;
  }
  throw new Error(`Invalid "dry-run" value "${raw}": use true or false.`);
}

export function readPruneConfig(): PruneConfig {
  return {
    olderThanDays: parsePositiveInt(core.getInput(Inputs.OlderThanDays), 'older-than-days'),
    ref: core.getInput(Inputs.Ref).trim(),
    dryRun: parseDryRun(core.getInput(Inputs.DryRun)),
    prefix: core.getInput(Inputs.Prefix),
    s3KeyPattern: core.getInput(Inputs.S3KeyPattern) || Defaults.DefaultS3KeyPattern,
    scopedToRepository: getInputAsBool(Inputs.ScopedToRepository, true),
    scopedToRef: getInputAsBool(Inputs.ScopedToRef, true),
    retryEnabled: getInputAsBool(Inputs.Retry, true),
    retryCount: getInputAsInt(Inputs.RetryCount) ?? Defaults.DefaultRetryCount,
    metricsFile: core.getInput(Inputs.MetricsFile).trim(),
  };
}

/**
 * Builds the storage/template pair pruning needs. No version or archive-format concern applies:
 * the template is compiled with an empty version and the zstd archive filename, and `./prune`
 * matches saved objects through `KeyTemplate.scopeMatcher`, which accepts any version and both
 * known archive filenames.
 */
export function buildPruneTier(
  config: PruneConfig,
  env: NodeJS.ProcessEnv = process.env
): PruneTier {
  const storage = createStorageContext({
    maxAttempts: config.retryEnabled ? config.retryCount + 1 : 1,
  });
  const template = compileKeyTemplate({
    pattern: config.s3KeyPattern,
    repository: env.GITHUB_REPOSITORY ?? '',
    prefix: config.prefix,
    scopedToRepository: config.scopedToRepository,
    scopedToRef: config.scopedToRef,
    version: '',
    archiveFilename: Defaults.DefaultArchiveFilenameZstd,
    env,
  });
  for (const warning of template.warnings) {
    core.warning(warning);
  }
  return { storage, template };
}

export async function pruneImpl(): Promise<void> {
  const start = Date.now();
  try {
    const config = readPruneConfig();
    if (config.ref && !config.scopedToRef) {
      throw new Error(
        'Refusing to prune: "ref" is set but "scoped-to-ref" is false, so cache keys contain no ref.'
      );
    }
    if (config.ref && !config.ref.startsWith('refs/')) {
      core.warning(
        `The "ref" input "${config.ref}" is not a full Git ref. Prune expects a full ref such as refs/heads/main, so it may match no caches.`
      );
    }

    const tier = buildPruneTier(config);
    const result = await pruneCaches(tier, {
      olderThanDays: config.olderThanDays,
      ref: config.ref || undefined,
      dryRun: config.dryRun,
    });

    core.setOutput(Outputs.PrunedCount, String(result.pruned.length));
    core.setOutput(Outputs.PrunedBytes, String(result.prunedBytes));
    core.setOutput(Outputs.KeptCount, String(result.keptCount));
    emitMetrics(
      {
        step: 'prune',
        timestamp: new Date().toISOString(),
        provider: tier.storage.providerConfig.provider,
        bytes: result.prunedBytes,
        durationMs: Date.now() - start,
        outcome: 'pruned',
        extra: {
          prunedCount: result.pruned.length,
          prunedBytes: result.prunedBytes,
          keptCount: result.keptCount,
          dryRun: result.dryRun,
        },
      },
      config.metricsFile,
      getWorkspace()
    );
  } catch (err) {
    core.setFailed(toError(err).message);
  }
}

export async function runPrune(earlyExit = true): Promise<void> {
  await pruneImpl();
  if (earlyExit) {
    // An explicit exit code overrides process.exitCode, so keep the one core.setFailed set.
    process.exit(process.exitCode ?? 0);
  }
}
