import { jest } from '@jest/globals';
import type { StepMetrics } from '../../../src/core/metrics';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockDebug = jest.fn<(message: string) => void>();
const mockWarning = jest.fn<(message: string) => void>();

jest.unstable_mockModule('@actions/core', () => ({
  debug: mockDebug,
  warning: mockWarning,
  info: jest.fn(),
}));

const { emitMetrics } = await import('../../../src/core/metrics');

const sample = (overrides: Partial<StepMetrics> = {}): StepMetrics => ({
  step: 'restore',
  timestamp: '2026-01-01T00:00:00.000Z',
  provider: 'seaweedfs',
  key: 'Linux-npm-abc',
  bytes: 2048,
  durationMs: 12,
  outcome: 'hit',
  ...overrides,
});

describe('emitMetrics', () => {
  let workspace: string;

  beforeEach(() => {
    jest.clearAllMocks();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-metrics-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('always debug-logs the metrics as one JSON line', () => {
    const metrics = sample();
    emitMetrics(metrics, '', workspace);
    expect(mockDebug).toHaveBeenCalledWith(`cloud-cache-metrics ${JSON.stringify(metrics)}`);
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it('writes nothing when no metrics file is configured', () => {
    emitMetrics(sample(), '', workspace);
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it('appends one JSON line per call, creating parent directories', () => {
    const first = sample();
    const second = sample({ step: 'save', outcome: 'saved', bytes: 4096 });
    emitMetrics(first, 'out/nested/metrics.jsonl', workspace);
    emitMetrics(second, 'out/nested/metrics.jsonl', workspace);

    const file = path.join(workspace, 'out', 'nested', 'metrics.jsonl');
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`
    );
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it('resolves an absolute metrics path as given', () => {
    const absolute = path.join(workspace, 'absolute.jsonl');
    const metrics = sample();
    emitMetrics(metrics, absolute, workspace);
    expect(fs.readFileSync(absolute, 'utf8')).toBe(`${JSON.stringify(metrics)}\n`);
  });

  it('warns once and never throws when the metrics file cannot be written', () => {
    fs.writeFileSync(path.join(workspace, 'blocker'), 'not a directory');
    const target = path.join(workspace, 'blocker', 'metrics.jsonl');

    expect(() => emitMetrics(sample(), 'blocker/metrics.jsonl', workspace)).not.toThrow();

    expect(mockWarning).toHaveBeenCalledTimes(1);
    expect(mockWarning.mock.calls[0][0]).toMatch(
      new RegExp(`^Could not write metrics to ${target.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')}: `)
    );
    expect(mockDebug).toHaveBeenCalledTimes(1);
  });
});
