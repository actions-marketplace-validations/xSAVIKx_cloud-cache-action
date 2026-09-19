/**
 * The `inspect` sub-action: it runs the restore lookup's listing pass and reports which object a
 * restore would download, without downloading or writing anything. Read-only by construction —
 * it only lists, so it is safe to run on any branch, in any job.
 */

import * as core from '@actions/core';
import { Inputs, Outputs } from '../constants';
import { parsePositiveInt } from '../utils/inputUtils';
import { readCacheConfig } from './config';
import { buildExplainReport, renderExplain, writeExplainSummary } from './explain';
import type { ExplainReport } from './explain';
import { toError } from './outcomes';
import { buildS3Tier } from './s3Tier';

/** GitHub truncates step outputs well before this, and a huge report is unusable anyway. */
const MAX_REPORT_BYTES = 65536;

/**
 * The report as JSON, or a small summary when the full report would not fit an output.
 * Consumers can always read `truncated` to tell the two shapes apart.
 */
function reportJson(report: ExplainReport, candidateCount: number): string {
  const full = JSON.stringify(report);
  if (Buffer.byteLength(full) <= MAX_REPORT_BYTES) {
    return full;
  }
  return JSON.stringify({
    truncated: true,
    wouldHit: Boolean(report.wouldHit),
    candidateCount,
  });
}

export async function inspectImpl(): Promise<void> {
  try {
    const config = readCacheConfig();
    if (!config.primaryKey) {
      throw new Error('Input required and not supplied: key');
    }
    if (config.paths.length === 0) {
      throw new Error('Input required and not supplied: path');
    }
    const maxCandidates = parsePositiveInt(
      core.getInput(Inputs.MaxCandidates) || '20',
      'max-candidates'
    );

    const tier = await buildS3Tier(config);
    core.setOutput(Outputs.CacheStorageProvider, tier.storage.providerConfig.provider);

    const report = await buildExplainReport(tier, config, { maxCandidates });
    core.startGroup('Cache lookup explained');
    try {
      for (const line of renderExplain(report)) {
        core.info(line);
      }
    } finally {
      core.endGroup();
    }
    await writeExplainSummary(report, config.jobSummary);

    const candidateCount = report.searches.reduce(
      (total, searched) => total + searched.candidates.length + searched.truncated,
      0
    );
    core.setOutput(Outputs.WouldHit, String(Boolean(report.wouldHit)));
    core.setOutput(Outputs.WouldMatchKey, report.wouldHit?.matchedKey ?? '');
    core.setOutput(Outputs.WouldMatchObject, report.wouldHit?.objectKey ?? '');
    core.setOutput(Outputs.CandidateCount, String(candidateCount));
    core.setOutput(Outputs.Report, reportJson(report, candidateCount));

    if (!report.wouldHit && config.failOnCacheMiss) {
      throw new Error(`No cache would be restored for key "${config.primaryKey}".`);
    }
  } catch (err) {
    core.setFailed(toError(err).message);
  }
}

export async function runInspect(earlyExit = true): Promise<void> {
  await inspectImpl();
  if (earlyExit) {
    // An explicit exit code overrides process.exitCode, so keep the one core.setFailed set.
    process.exit(process.exitCode ?? 0);
  }
}
