import * as core from '@actions/core';
import { formatSize } from '../utils/inputUtils';
import { toError } from './outcomes';

export type CacheSource = 's3' | 'github' | 'none';

/** Data for the restore step's job summary table. `jobSummary` is the resolved job-summary input. */
export interface RestoreSummaryData {
  jobSummary: boolean;
  primaryKey: string;
  matchedKey?: string;
  cacheHit: boolean;
  source: CacheSource;
  size?: number;
  durationMs: number;
}

/** Data for the save step's job summary table. `jobSummary` is the resolved job-summary input. */
export interface SaveSummaryData {
  jobSummary: boolean;
  key: string;
  savedTo: Array<'s3' | 'github'>;
  size?: number;
  durationMs: number;
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(2)} s`;
}

function formatOptionalSize(size?: number): string {
  return size === undefined ? '—' : formatSize(size);
}

/** Only write when the job-summary input is on and GitHub gave us a summary file to write to. */
function canWrite(jobSummary: boolean): boolean {
  return jobSummary && Boolean(process.env.GITHUB_STEP_SUMMARY);
}

/** A write failure (missing/unwritable summary file) is logged at debug level and never thrown. */
async function flush(): Promise<void> {
  try {
    await core.summary.write();
  } catch (err) {
    core.debug(`Failed to write the job summary: ${toError(err).message}`);
    core.summary.emptyBuffer();
  }
}

export async function writeRestoreSummary(data: RestoreSummaryData): Promise<void> {
  if (!canWrite(data.jobSummary)) {
    return;
  }
  core.summary.addHeading('Cloud cache restore').addTable([
    [
      { data: 'Primary key', header: true },
      { data: 'Matched key', header: true },
      { data: 'Cache hit', header: true },
      { data: 'Source', header: true },
      { data: 'Size', header: true },
      { data: 'Duration', header: true },
    ],
    [
      data.primaryKey,
      data.matchedKey ?? '—',
      String(data.cacheHit),
      data.source,
      formatOptionalSize(data.size),
      formatDuration(data.durationMs),
    ],
  ]);
  await flush();
}

export async function writeSaveSummary(data: SaveSummaryData): Promise<void> {
  if (!canWrite(data.jobSummary)) {
    return;
  }
  core.summary.addHeading('Cloud cache save').addTable([
    [
      { data: 'Key', header: true },
      { data: 'Saved to', header: true },
      { data: 'Size', header: true },
      { data: 'Duration', header: true },
    ],
    [
      data.key,
      data.savedTo.length > 0 ? data.savedTo.join(', ') : 'none',
      formatOptionalSize(data.size),
      formatDuration(data.durationMs),
    ],
  ]);
  await flush();
}
