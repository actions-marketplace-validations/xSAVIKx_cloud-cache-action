import * as core from '@actions/core';
import { Defaults, Inputs, Outputs } from '../constants';
import { createStorageContext } from '../storage/client';
import { getInputAsBool, getInputAsInt } from '../utils/inputUtils';
import { compileKeyTemplate } from './keyTemplate';
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
  retryEnabled: boolean;
  retryCount: number;
}

function parseOlderThanDays(raw: string): number {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed) || Number(trimmed) <= 0) {
    throw new Error(`Input "older-than-days" must be a positive integer; got "${raw}".`);
  }
  return Number(trimmed);
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
    olderThanDays: parseOlderThanDays(core.getInput(Inputs.OlderThanDays)),
    ref: core.getInput(Inputs.Ref).trim(),
    dryRun: parseDryRun(core.getInput(Inputs.DryRun)),
    prefix: core.getInput(Inputs.Prefix),
    s3KeyPattern: core.getInput(Inputs.S3KeyPattern) || Defaults.DefaultS3KeyPattern,
    scopedToRepository: getInputAsBool(Inputs.ScopedToRepository, true),
    retryEnabled: getInputAsBool(Inputs.Retry, true),
    retryCount: getInputAsInt(Inputs.RetryCount) ?? Defaults.DefaultRetryCount,
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
    scopedToRef: true,
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
  try {
    const config = readPruneConfig();
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
