import { jest } from '@jest/globals';
import { Inputs } from '../../../src/constants';
import type { ExplainConfig, ExplainOptions, ExplainReport } from '../../../src/core/explain';
import type { S3Tier } from '../../../src/core/s3Tier';
import type { CacheConfig } from '../../../src/core/config';

const inputs = new Map<string, string>();
const outputs = new Map<string, string>();
// Like the real core.setFailed, which only sets process.exitCode.
const mockSetFailed = jest.fn<(message: string) => void>(() => {
  process.exitCode = 1;
});
const mockInfo = jest.fn<(message: string) => void>();
const mockWarning = jest.fn<(message: string) => void>();
const mockStartGroup = jest.fn<(name: string) => void>();
const mockEndGroup = jest.fn<() => void>();
const mockBuildS3Tier = jest.fn<(config: CacheConfig) => Promise<S3Tier>>();
const mockBuildExplainReport =
  jest.fn<
    (tier: S3Tier, config: ExplainConfig, options: ExplainOptions) => Promise<ExplainReport>
  >();
const mockRenderExplain = jest.fn<(report: ExplainReport) => string[]>();
const mockWriteExplainSummary =
  jest.fn<(report: ExplainReport, jobSummary: boolean) => Promise<void>>();

jest.unstable_mockModule('@actions/core', () => ({
  getInput: (name: string) => inputs.get(name) ?? '',
  setOutput: (name: string, value: string) => {
    outputs.set(name, value);
  },
  setFailed: mockSetFailed,
  info: mockInfo,
  warning: mockWarning,
  debug: jest.fn(),
  startGroup: mockStartGroup,
  endGroup: mockEndGroup,
}));
jest.unstable_mockModule('../../../src/core/s3Tier', () => ({
  buildS3Tier: mockBuildS3Tier,
}));
jest.unstable_mockModule('../../../src/core/explain', () => ({
  buildExplainReport: mockBuildExplainReport,
  renderExplain: mockRenderExplain,
  writeExplainSummary: mockWriteExplainSummary,
}));

const { inspectImpl } = await import('../../../src/core/inspectImpl');

const tier = {
  storage: {
    client: {},
    bucket: 'bucket',
    providerConfig: { provider: 'seaweedfs', region: 'us-east-1', forcePathStyle: true },
  },
} as unknown as S3Tier;

function makeReport(overrides: Partial<ExplainReport> = {}): ExplainReport {
  return {
    provider: 'seaweedfs',
    bucket: 'bucket',
    pattern: 'p',
    resolvedPattern: 'p',
    version: 'v1',
    versionInputs: { paths: ['data'], compression: 'zstd', crossOs: false },
    refs: ['refs/heads/main'],
    primaryKey: 'k',
    restoreKeys: [],
    tiers: ['s3'],
    searches: [],
    reasons: [],
    ...overrides,
  };
}

describe('inspectImpl', () => {
  beforeEach(() => {
    inputs.clear();
    outputs.clear();
    jest.clearAllMocks();
    process.exitCode = undefined;
    process.env.GITHUB_REPOSITORY = 'octo/app';
    inputs.set(Inputs.Bucket, 'bucket');
    inputs.set(Inputs.Key, 'k');
    inputs.set(Inputs.Path, 'data');
    mockBuildS3Tier.mockResolvedValue(tier);
    mockRenderExplain.mockReturnValue(['line one', 'line two']);
    mockWriteExplainSummary.mockResolvedValue(undefined);
    mockBuildExplainReport.mockResolvedValue(makeReport());
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('sets the would-hit outputs and the report on a hit', async () => {
    const report = makeReport({
      searches: [
        {
          ref: 'refs/heads/main',
          key: 'k',
          prefix: 'octo/app/refs%2Fheads%2Fmain/k/',
          candidates: [
            {
              objectKey: 'octo/app/refs%2Fheads%2Fmain/k/v1/cache.tar.zst',
              version: 'v1',
              sizeBytes: 10,
              lastModified: '',
              versionMatches: true,
            },
          ],
          truncated: 2,
        },
      ],
      wouldHit: {
        objectKey: 'octo/app/refs%2Fheads%2Fmain/k/v1/cache.tar.zst',
        matchedKey: 'k',
        exact: true,
        ref: 'refs/heads/main',
      },
    });
    mockBuildExplainReport.mockResolvedValue(report);

    await inspectImpl();

    expect(outputs.get('would-hit')).toBe('true');
    expect(outputs.get('would-match-key')).toBe('k');
    expect(outputs.get('would-match-object')).toBe(
      'octo/app/refs%2Fheads%2Fmain/k/v1/cache.tar.zst'
    );
    expect(outputs.get('candidate-count')).toBe('3');
    expect(JSON.parse(outputs.get('report') as string)).toEqual(report);
    expect(outputs.get('cache-storage-provider')).toBe('seaweedfs');
    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('logs the rendered report inside a group and writes the job summary', async () => {
    await inspectImpl();
    expect(mockStartGroup).toHaveBeenCalledWith('Cache lookup explained');
    expect(mockInfo).toHaveBeenCalledWith('line one');
    expect(mockInfo).toHaveBeenCalledWith('line two');
    expect(mockEndGroup).toHaveBeenCalled();
    expect(mockWriteExplainSummary).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('closes the log group even when rendering throws', async () => {
    mockRenderExplain.mockImplementation(() => {
      throw new Error('render boom');
    });
    await inspectImpl();
    expect(mockEndGroup).toHaveBeenCalled();
    expect(mockSetFailed).toHaveBeenCalledWith('render boom');
  });

  it('sets empty match outputs and exits 0 on a miss', async () => {
    mockBuildExplainReport.mockResolvedValue(makeReport());
    await inspectImpl();
    expect(outputs.get('would-hit')).toBe('false');
    expect(outputs.get('would-match-key')).toBe('');
    expect(outputs.get('would-match-object')).toBe('');
    expect(outputs.get('candidate-count')).toBe('0');
    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('fails on a miss when fail-on-cache-miss is true', async () => {
    inputs.set(Inputs.FailOnCacheMiss, 'true');
    await inspectImpl();
    expect(mockSetFailed).toHaveBeenCalledWith('No cache would be restored for key "k".');
    // The outputs are still set before the failure.
    expect(outputs.get('would-hit')).toBe('false');
  });

  it('does not fail on a hit when fail-on-cache-miss is true', async () => {
    inputs.set(Inputs.FailOnCacheMiss, 'true');
    mockBuildExplainReport.mockResolvedValue(
      makeReport({ wouldHit: { objectKey: 'o', matchedKey: 'k', exact: true, ref: null } })
    );
    await inspectImpl();
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it('replaces a report larger than 64 KB with a truncated summary', async () => {
    const candidates = Array.from({ length: 400 }, (_, i) => ({
      objectKey: `octo/app/k/v1/${'x'.repeat(200)}-${i}.tar.zst`,
      version: 'v1',
      sizeBytes: i,
      lastModified: '',
      versionMatches: true,
    }));
    mockBuildExplainReport.mockResolvedValue(
      makeReport({
        searches: [{ ref: null, key: 'k', prefix: 'p', candidates, truncated: 0 }],
        wouldHit: { objectKey: 'o', matchedKey: 'k', exact: false, ref: null },
      })
    );

    await inspectImpl();

    const raw = outputs.get('report') as string;
    expect(Buffer.byteLength(raw)).toBeLessThan(200);
    expect(JSON.parse(raw)).toEqual({ truncated: true, wouldHit: true, candidateCount: 400 });
  });

  it('passes max-candidates through to buildExplainReport', async () => {
    inputs.set(Inputs.MaxCandidates, '5');
    await inspectImpl();
    expect(mockBuildExplainReport).toHaveBeenCalledWith(tier, expect.anything(), {
      maxCandidates: 5,
    });
  });

  it('defaults max-candidates to 20', async () => {
    await inspectImpl();
    expect(mockBuildExplainReport).toHaveBeenCalledWith(tier, expect.anything(), {
      maxCandidates: 20,
    });
  });

  it.each(['0', 'x', '-1', '1.5'])(
    'fails before building the tier when max-candidates is "%s"',
    async (value) => {
      inputs.set(Inputs.MaxCandidates, value);
      await inspectImpl();
      expect(mockSetFailed).toHaveBeenCalledWith(
        `Input "max-candidates" must be a positive integer; got "${value}".`
      );
      expect(mockBuildS3Tier).not.toHaveBeenCalled();
      expect(mockBuildExplainReport).not.toHaveBeenCalled();
    }
  );

  it('fails when key is missing', async () => {
    inputs.delete(Inputs.Key);
    await inspectImpl();
    expect(mockSetFailed).toHaveBeenCalledWith('Input required and not supplied: key');
    expect(mockBuildS3Tier).not.toHaveBeenCalled();
  });

  it('fails when path is missing', async () => {
    inputs.delete(Inputs.Path);
    await inspectImpl();
    expect(mockSetFailed).toHaveBeenCalledWith('Input required and not supplied: path');
    expect(mockBuildS3Tier).not.toHaveBeenCalled();
  });

  it('fails the step when the lookup throws', async () => {
    mockBuildExplainReport.mockRejectedValue(new Error('boom'));
    await inspectImpl();
    expect(mockSetFailed).toHaveBeenCalledWith('boom');
  });
});
