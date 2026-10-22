import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StepMetrics } from '../../../src/core/metrics';
import { formatTimings } from '../../../src/core/timings';

const MiB = 1024 * 1024;

const sample = (overrides: Partial<StepMetrics> = {}): StepMetrics => ({
  step: 'restore',
  timestamp: '2026-01-01T00:00:00.000Z',
  bytes: 512 * MiB,
  durationMs: 4500,
  transferDurationMs: 3200,
  outcome: 'hit',
  ...overrides,
});

describe('formatTimings', () => {
  it('lists the restore phases with the download rate', () => {
    expect(formatTimings(sample({ lookupDurationMs: 210, extractDurationMs: 1020 }))).toBe(
      'Timings: lookup 0.21 s, download 3.20 s (160.0 MiB/s), extract 1.02 s, total 4.50 s'
    );
  });

  it('lists the save phases with the upload rate', () => {
    expect(
      formatTimings(
        sample({
          step: 'save',
          outcome: 'saved',
          archiveDurationMs: 1500,
          transferDurationMs: 2000,
          durationMs: 3700,
        })
      )
    ).toBe('Timings: archive 1.50 s, upload 2.00 s (256.0 MiB/s), total 3.70 s');
  });

  it('leaves out the phases that did not run, as in a streaming restore', () => {
    expect(formatTimings(sample({ streaming: true }))).toBe(
      'Timings: download 3.20 s (160.0 MiB/s), total 4.50 s'
    );
  });

  it('gives no line for a hit with no S3 download, as from the GitHub tier', () => {
    expect(formatTimings(sample({ transferDurationMs: 0 }))).toBeUndefined();
  });

  it('gives a line with a note for a save that uploaded and then found another job saved first', () => {
    expect(
      formatTimings(
        sample({ step: 'save', outcome: 'exists', archiveDurationMs: 1500, durationMs: 4900 })
      )
    ).toBe(
      'Timings: archive 1.50 s, upload 3.20 s (160.0 MiB/s), total 4.90 s (another job saved first)'
    );
  });

  it('gives no line when no transfer happened', () => {
    expect(
      formatTimings(sample({ outcome: 'miss', transferDurationMs: undefined }))
    ).toBeUndefined();
    expect(formatTimings(sample({ outcome: 'miss', transferDurationMs: 0 }))).toBeUndefined();
    expect(
      formatTimings(sample({ step: 'save', outcome: 'exists', transferDurationMs: 0 }))
    ).toBeUndefined();
    expect(
      formatTimings(sample({ step: 'save', outcome: 'skipped', transferDurationMs: 0 }))
    ).toBeUndefined();
    expect(
      formatTimings(sample({ outcome: 'error', transferDurationMs: undefined }))
    ).toBeUndefined();
  });

  it('stays free of runtime imports, so any CI front end can use it', () => {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../src/core/timings.ts'),
      'utf8'
    );
    const imports = source.split('\n').filter((line) => /^import\s/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((line) => line.startsWith('import type '))).toBe(true);
  });
});
