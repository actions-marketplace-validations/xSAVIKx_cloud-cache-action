import { jest } from '@jest/globals';
import { Inputs, Outputs, State } from '../../src/constants';
import type { IStateProvider } from '../../src/state';

const mockGetInput = jest.fn<(name: string, options?: unknown) => string>();
const mockSetOutput = jest.fn<(name: string, value: string) => void>();
const mockSetFailed = jest.fn<(msg: string) => void>();
const mockInfo = jest.fn<(msg: string) => void>();
const mockWarning = jest.fn<(msg: string) => void>();
const mockDebug = jest.fn<(msg: string) => void>();

const mockCreateStorageContext = jest.fn<() => unknown>();
const mockCheckObjectExists =
  jest.fn<(client: unknown, bucket: string, key: string) => Promise<unknown>>();
const mockListObjectsWithPrefix =
  jest.fn<(client: unknown, bucket: string, prefix: string) => Promise<unknown[]>>();
const mockDownloadFile =
  jest.fn<(client: unknown, bucket: string, key: string, target: string) => Promise<void>>();
const mockGetCompressionConfig =
  jest.fn<() => Promise<{ method: 'zstd' | 'gzip'; archiveFilename: string }>>();
const mockExtractArchive =
  jest.fn<(archivePath: string, config: unknown, target?: string) => Promise<void>>();
const mockFallbackRestore =
  jest.fn<
    (
      paths: string[],
      primaryKey: string,
      restoreKeys: string[],
      options?: unknown,
      crossOs?: boolean
    ) => Promise<string | undefined>
  >();

jest.unstable_mockModule('@actions/core', () => ({
  getInput: mockGetInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  info: mockInfo,
  warning: mockWarning,
  debug: mockDebug,
}));

jest.unstable_mockModule('../../src/storage/client', () => ({
  createStorageContext: mockCreateStorageContext,
}));

jest.unstable_mockModule('../../src/storage/operations', () => ({
  checkObjectExists: mockCheckObjectExists,
  listObjectsWithPrefix: mockListObjectsWithPrefix,
  downloadFile: mockDownloadFile,
}));

jest.unstable_mockModule('../../src/archive/compression', () => ({
  getCompressionConfig: mockGetCompressionConfig,
}));

jest.unstable_mockModule('../../src/archive/tar', () => ({
  extractArchive: mockExtractArchive,
}));

jest.unstable_mockModule('../../src/utils/fallback', () => ({
  fallbackRestore: mockFallbackRestore,
}));

const { restoreImpl, runRestore, runRestoreOnly } = await import('../../src/core/restoreImpl');

class TestStateProvider implements IStateProvider {
  private map = new Map<string, string>();
  getCacheState(): string {
    return this.map.get(State.CacheMatchedKey) || '';
  }
  getState(key: string): string {
    return this.map.get(key) || '';
  }
  setState(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe('Core Restore Implementation (restoreImpl)', () => {
  let state: TestStateProvider;
  const mockStorageContext = {
    client: {},
    bucket: 'test-bucket',
    providerConfig: {
      provider: 'aws',
      region: 'us-east-1',
      forcePathStyle: false,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GITHUB_EVENT_NAME = 'push';
    state = new TestStateProvider();

    mockCreateStorageContext.mockReturnValue(mockStorageContext);
    mockGetCompressionConfig.mockResolvedValue({
      method: 'zstd',
      archiveFilename: 'cache.tar.zst',
    });
    mockExtractArchive.mockResolvedValue();
    mockDownloadFile.mockResolvedValue();

    mockGetInput.mockImplementation((name: string) => {
      switch (name) {
        case Inputs.Key:
          return 'Linux-node-abc123';
        case Inputs.Path:
          return 'node_modules\n.npm';
        case Inputs.ScopedToRepository:
          return 'true';
        case Inputs.Retry:
          return 'false';
        default:
          return '';
      }
    });
  });

  it('restores cache on exact primary key hit in S3', async () => {
    mockCheckObjectExists.mockResolvedValueOnce({
      size: 1024 * 1024,
      etag: '"test-etag"',
    });

    const result = await restoreImpl(state, false);

    expect(result).toBe('Linux-node-abc123');
    expect(mockDownloadFile).toHaveBeenCalledTimes(1);
    expect(mockExtractArchive).toHaveBeenCalledTimes(1);
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheHit, 'true');
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheHitSource, 's3');
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheMatchedKey, 'Linux-node-abc123');
    expect(state.getState(State.CacheS3ExactHit)).toBe('true');
  });

  it('restores cache on prefix match from restore-keys in S3', async () => {
    // Exact primary key not found
    mockCheckObjectExists.mockResolvedValueOnce(null);

    mockGetInput.mockImplementation((name: string) => {
      if (name === Inputs.Key) return 'Linux-node-abc123';
      if (name === Inputs.Path) return 'node_modules';
      if (name === Inputs.RestoreKeys) return 'Linux-node-\nLinux-';
      return '';
    });

    mockListObjectsWithPrefix.mockResolvedValueOnce([
      {
        key: 'prefix/Linux-node-def456/cache.tar.zst',
        size: 512,
        lastModified: new Date('2026-01-01T12:00:00Z'),
        etag: '"prefix-etag"',
      },
    ]);

    const result = await restoreImpl(state, false);

    expect(result).toBe('Linux-node-def456');
    expect(mockDownloadFile).toHaveBeenCalledTimes(1);
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheHit, 'false');
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheHitSource, 's3');
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheMatchedKey, 'Linux-node-def456');
  });

  it('performs lookup-only without downloading archive when lookup-only is true', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === Inputs.Key) return 'Linux-node-abc123';
      if (name === Inputs.Path) return 'node_modules';
      if (name === Inputs.LookupOnly) return 'true';
      return '';
    });

    mockCheckObjectExists.mockResolvedValueOnce({
      size: 2048,
      etag: '"etag"',
    });

    const result = await restoreImpl(state, false);

    expect(result).toBe('Linux-node-abc123');
    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(mockExtractArchive).not.toHaveBeenCalled();
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheHit, 'true');
  });

  it('returns undefined and logs info when cache is not found and fail-on-cache-miss is false', async () => {
    mockCheckObjectExists.mockResolvedValueOnce(null);
    mockListObjectsWithPrefix.mockResolvedValue([]);

    const result = await restoreImpl(state, false);

    expect(result).toBeUndefined();
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheHit, 'false');
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheHitSource, 'none');
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it('fails workflow when cache misses and fail-on-cache-miss is true', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === Inputs.Key) return 'Linux-node-abc123';
      if (name === Inputs.Path) return 'node_modules';
      if (name === Inputs.FailOnCacheMiss) return 'true';
      return '';
    });

    mockCheckObjectExists.mockResolvedValueOnce(null);

    await restoreImpl(state, false);

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('fail-on-cache-miss is set')
    );
  });

  it('dual-cache github-first: restores from GitHub first and skips S3 on hit', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === Inputs.Key) return 'Linux-node-abc123';
      if (name === Inputs.Path) return 'node_modules';
      if (name === Inputs.DualCache) return 'true';
      if (name === Inputs.RestorePriority) return 'github-first';
      return '';
    });

    mockFallbackRestore.mockResolvedValueOnce('Linux-node-abc123');

    const result = await restoreImpl(state, false);

    expect(result).toBe('Linux-node-abc123');
    expect(mockFallbackRestore).toHaveBeenCalledTimes(1);
    expect(mockCheckObjectExists).not.toHaveBeenCalled();
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheHitSource, 'github');
    expect(state.getState(State.CacheGithubExactHit)).toBe('true');
  });

  it('dual-cache github-first: falls back to S3 when GitHub misses', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === Inputs.Key) return 'Linux-node-abc123';
      if (name === Inputs.Path) return 'node_modules';
      if (name === Inputs.DualCache) return 'true';
      if (name === Inputs.RestorePriority) return 'github-first';
      return '';
    });

    mockFallbackRestore.mockResolvedValueOnce(undefined);
    mockCheckObjectExists.mockResolvedValueOnce({
      size: 4096,
      etag: '"s3-etag"',
    });

    const result = await restoreImpl(state, false);

    expect(result).toBe('Linux-node-abc123');
    expect(mockFallbackRestore).toHaveBeenCalledTimes(1);
    expect(mockCheckObjectExists).toHaveBeenCalledTimes(1);
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheHitSource, 's3');
  });

  it('dual-cache s3-first: restores from S3 first and falls back to GitHub on miss', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === Inputs.Key) return 'Linux-node-abc123';
      if (name === Inputs.Path) return 'node_modules';
      if (name === Inputs.DualCache) return 'true';
      if (name === Inputs.RestorePriority) return 's3-first';
      return '';
    });

    mockCheckObjectExists.mockResolvedValueOnce(null);
    mockFallbackRestore.mockResolvedValueOnce('Linux-node-abc123');

    const result = await restoreImpl(state, false);

    expect(result).toBe('Linux-node-abc123');
    expect(mockCheckObjectExists).toHaveBeenCalledTimes(1);
    expect(mockFallbackRestore).toHaveBeenCalledTimes(1);
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheHitSource, 'github');
  });

  it('use-fallback: queries GitHub cache when pure S3 misses', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === Inputs.Key) return 'Linux-node-abc123';
      if (name === Inputs.Path) return 'node_modules';
      if (name === Inputs.UseFallback) return 'true';
      return '';
    });

    mockCheckObjectExists.mockResolvedValueOnce(null);
    mockFallbackRestore.mockResolvedValueOnce('Linux-node-abc123');

    const result = await restoreImpl(state, false);

    expect(result).toBe('Linux-node-abc123');
    expect(mockFallbackRestore).toHaveBeenCalledTimes(1);
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheHitSource, 'github');
  });

  it('runs runRestore and runRestoreOnly helper wrappers without errors', async () => {
    mockCheckObjectExists.mockResolvedValueOnce({
      size: 100,
    });

    await expect(runRestore(false)).resolves.not.toThrow();
    await expect(runRestoreOnly(false)).resolves.not.toThrow();
  });
});
