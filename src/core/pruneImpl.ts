import * as core from '@actions/core';
import { Defaults, Inputs, Outputs } from '../constants';
import { createStorageContext } from '../storage/client';
import { getInputAsBool, getInputAsInt } from '../utils/inputUtils';
import { compileKeyTemplate } from './keyTemplate';
import { toError } from './outcomes';
import { pruneCaches, type PruneTier } from './prune';

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

/**
 * s3-key-pattern text puts ${ref} before ${GITHUB_REPOSITORY} or ${prefix} places ${ref} before
 * ${prefix} while a prefix is configured, `KeyTemplate.scopePrefix(undefined)` truncates at the
 * ref placeholder and returns a prefix that does not include the repository or prefix segment --
 * broader than what the pattern really produces, so an all-refs prune could delete another
 * repository's caches. Checked against the raw, unresolved pattern text.
 */
function refPlacementIsUnsafeForAllRefs(
  pattern: string,
  scopedToRepository: boolean,
  prefix: string
): boolean {
  const refIndex = pattern.indexOf('${ref}');
  if (refIndex === -1) {
    return false;
  }
  if (scopedToRepository) {
    const repositoryIndex = pattern.indexOf('${GITHUB_REPOSITORY}');
    if (repositoryIndex !== -1 && refIndex < repositoryIndex) {
      return true;
    }
  }
  if (prefix.trim() !== '') {
    const prefixIndex = pattern.indexOf('${prefix}');
    if (prefixIndex !== -1 && refIndex < prefixIndex) {
      return true;
    }
  }
  return false;
}

function parseOlderThanDays(raw: string): number {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed) || Number(trimmed) <= 0) {
    throw new Error(`Input "older-than-days" must be a positive integer; got "${raw}".`);
  }
  return Number(trimmed);
}

export function readPruneConfig(): PruneConfig {
  return {
    olderThanDays: parseOlderThanDays(core.getInput(Inputs.OlderThanDays)),
    ref: core.getInput(Inputs.Ref).trim(),
    dryRun: getInputAsBool(Inputs.DryRun),
    prefix: core.getInput(Inputs.Prefix),
    s3KeyPattern: core.getInput(Inputs.S3KeyPattern) || Defaults.DefaultS3KeyPattern,
    scopedToRepository: getInputAsBool(Inputs.ScopedToRepository, true),
    retryEnabled: getInputAsBool(Inputs.Retry, true),
    retryCount: getInputAsInt(Inputs.RetryCount) ?? Defaults.DefaultRetryCount,
  };
}

/**
 * Builds the storage/template pair pruning needs. No version or archive-format concern applies:
 * the template is compiled with an empty version and the zstd archive filename, and matching
 * against saved objects goes through the archive-suffix logic in `./prune`, which recognizes
 * both known archive filenames regardless of which one the template carries.
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
    if (
      !config.ref &&
      refPlacementIsUnsafeForAllRefs(config.s3KeyPattern, config.scopedToRepository, config.prefix)
    ) {
      throw new Error(
        'Refusing to prune all refs: s3-key-pattern places ${ref} before the repository or prefix, so the listing would include other repositories\' caches. Set the "ref" input to prune a single ref.'
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
