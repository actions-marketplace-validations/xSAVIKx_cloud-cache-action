/**
 * The one-line phase summary a restore or save step logs after an S3 transfer. Pure on purpose:
 * it takes the step's metrics and returns text, so any CI front end can print it.
 */

import type { StepMetrics } from './metrics';

const MiB = 1024 * 1024;

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Returns `Timings: lookup …, download … (… MiB/s), extract …, total …` for a hit, or the
 * archive and upload phases for a save. Phases a step did not measure are left out. `total` is
 * the whole step, and the transfer time includes retries. Returns undefined when the step moved
 * no bytes through S3.
 */
export function formatTimings(metrics: StepMetrics): string | undefined {
  const transferMs = metrics.transferDurationMs;
  if (transferMs === undefined || transferMs <= 0) {
    return undefined;
  }
  const rate = `${(metrics.bytes / MiB / (transferMs / 1000)).toFixed(1)} MiB/s`;
  const transfer = `${metrics.step === 'save' ? 'upload' : 'download'} ${seconds(transferMs)} (${rate})`;
  const parts = [
    metrics.lookupDurationMs === undefined
      ? undefined
      : `lookup ${seconds(metrics.lookupDurationMs)}`,
    metrics.archiveDurationMs === undefined
      ? undefined
      : `archive ${seconds(metrics.archiveDurationMs)}`,
    transfer,
    metrics.extractDurationMs === undefined
      ? undefined
      : `extract ${seconds(metrics.extractDurationMs)}`,
    `total ${seconds(metrics.durationMs)}`,
  ];
  const note = metrics.outcome === 'exists' ? ' (another job saved first)' : '';
  return `Timings: ${parts.filter((part) => part !== undefined).join(', ')}${note}`;
}
