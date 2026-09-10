import { jest } from '@jest/globals';
import { Inputs, Outputs, State } from '../../src/constants';
import type { IStateProvider } from '../../src/state';

const mockGetInput = jest.fn<(name: string, options?: unknown) => string>();
const mockSetOutput = jest.fn<(name: string, value: string) => void>();
const mockInfo = jest.fn<(msg: string) => void>();
const mockWarning = jest.fn<(msg: string) => void>();
const mockDebug = jest.fn<(msg: string) => void>();

const mockCreateStorageContext = jest.fn<() => unknown>();
const mockCheckObjectExists =
  jest.fn<(client: unknown, bucket: string, key: string) => Promise<unknown>>();
const mockUploadFile =
  jest.fn<
    (
      client: unknown,
      bucket: string,
      key: string,
      file: string,
      chunkSize?: number
    ) => Promise<{ size: number; etag?: string }>
  >();
const mockGetCompressionConfig =
  jest.fn<() => Promise<{ method: 'zstd' | 'gzip'; archiveFilename: string }>>();
const mockCreateArchive =
  jest.fn<
    (archivePath: string, paths: string[], config: unknown, crossOs?: boolean) => Promise<void>
  >();
const mockGetArchiveSize = jest.fn<(path: string) => number>();
const mockFallbackSave =
  jest.fn<
    (
      paths: string[],
      key: string,
      options?: unknown,
      crossOs?: boolean
    ) => Promise<number | undefined>
  >();

jest.unstable_mockModule('@actions/core', () => ({
  getInput: mockGetInput,
  setOutput: mockSetOutput,
  info: mockInfo,
  warning: mockWarning,
  debug: mockDebug,
}));

jest.unstable_mockModule('../../src/storage/client', () => ({
  createStorageContext: mockCreateStorageContext,
}));

jest.unstable_mockModule('../../src/storage/operations', () => ({
  checkObjectExists: mockCheckObjectExists,
  uploadFile: mockUploadFile,
}));

jest.unstable_mockModule('../../src/archive/compression', () => ({
  getCompressionConfig: mockGetCompressionConfig,
}));

jest.unstable_mockModule('../../src/archive/tar', () => ({
  createArchive: mockCreateArchive,
  getArchiveSize: mockGetArchiveSize,
}));

jest.unstable_mockModule('../../src/utils/fallback', () => ({
  fallbackSave: mockFallbackSave,
}));

const { saveImpl, runSave, runSaveOnly } = await import('../../src/core/saveImpl');

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

describe('Core Save Implementation (saveImpl)', () => {
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
    mockCreateArchive.mockResolvedValue();
    mockGetArchiveSize.mockReturnValue(2048);
    mockUploadFile.mockResolvedValue({ size: 2048, etag: '"saved-etag"' });
    mockCheckObjectExists.mockResolvedValue(null);

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

  it('skips save when read-only is true', async () => {
    state.setState(State.CacheReadOnly, 'true');

    await saveImpl(state);

    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Read-only mode enabled'));
    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(mockFallbackSave).not.toHaveBeenCalled();
  });

  it('skips save when primary key is missing', async () => {
    mockGetInput.mockReturnValue('');

    await saveImpl(state);

    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('Key is not specified'));
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('skips save when path list is empty', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === Inputs.Key) return 'Linux-node-abc123';
      if (name === Inputs.Path) return '';
      return '';
    });

    await saveImpl(state);

    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('No paths specified to cache')
    );
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('skips pure S3 save when cache hit occurred on primary key during restore', async () => {
    state.setState(State.CachePrimaryKey, 'Linux-node-abc123');
    state.setState(State.CacheMatchedKey, 'Linux-node-abc123');

    await saveImpl(state);

    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('not saving cache'));
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheSavedSources, 'none');
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('skips upload when object already exists in S3', async () => {
    mockCheckObjectExists.mockResolvedValueOnce({
      size: 4096,
      etag: '"existing-etag"',
    });

    await saveImpl(state);

    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Cache object already exists'));
    expect(mockCreateArchive).not.toHaveBeenCalled();
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('performs standard archive creation and upload to S3', async () => {
    const size = await saveImpl(state);

    expect(size).toBe(2048);
    expect(mockCreateArchive).toHaveBeenCalledTimes(1);
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheSavedSources, 's3');
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheSize, '2048');
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheETag, '"saved-etag"');
  });

  it('falls back to GitHub save when S3 upload fails and use-fallback is true', async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === Inputs.Key) return 'Linux-node-abc123';
      if (name === Inputs.Path) return 'node_modules';
      if (name === Inputs.UseFallback) return 'true';
      if (name === Inputs.Retry) return 'false';
      return '';
    });
    state.setState(State.CacheRetry, 'false');

    mockUploadFile.mockRejectedValue(new Error('S3 Connection Timed Out'));
    mockFallbackSave.mockResolvedValue(12345);

    await saveImpl(state);

    expect(mockFallbackSave).toHaveBeenCalledTimes(1);
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheSavedSources, 'github');
  });

  it('dual-cache backfill: saves to S3 when GitHub Cache had exact hit', async () => {
    state.setState(State.CacheDualCache, 'true');
    state.setState(State.CacheDualCacheStrategy, 'backfill');
    state.setState(State.CacheGithubExactHit, 'true');

    await saveImpl(state);

    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockFallbackSave).not.toHaveBeenCalled();
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheSavedSources, 'github,s3');
  });

  it('dual-cache backfill: saves to GitHub when S3 had exact hit', async () => {
    state.setState(State.CacheDualCache, 'true');
    state.setState(State.CacheDualCacheStrategy, 'backfill');
    state.setState(State.CacheS3ExactHit, 'true');
    mockFallbackSave.mockResolvedValueOnce(999);

    await saveImpl(state);

    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(mockFallbackSave).toHaveBeenCalledTimes(1);
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheSavedSources, 's3,github');
  });

  it('dual-cache backfill: saves to both tiers when neither had a hit', async () => {
    state.setState(State.CacheDualCache, 'true');
    state.setState(State.CacheDualCacheStrategy, 'backfill');
    mockFallbackSave.mockResolvedValueOnce(1001);

    await saveImpl(state);

    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockFallbackSave).toHaveBeenCalledTimes(1);
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheSavedSources, 's3,github');
  });

  it('dual-cache skip-on-hit: skips both tiers when one tier had an exact hit', async () => {
    state.setState(State.CacheDualCache, 'true');
    state.setState(State.CacheDualCacheStrategy, 'skip-on-hit');
    state.setState(State.CacheS3ExactHit, 'true');

    await saveImpl(state);

    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(mockFallbackSave).not.toHaveBeenCalled();
    expect(mockSetOutput).toHaveBeenCalledWith(Outputs.CacheSavedSources, 's3');
  });

  it('dual-cache strict: re-throws error on S3 save failure', async () => {
    state.setState(State.CacheDualCache, 'true');
    state.setState(State.CacheDualCacheStrict, 'true');
    mockUploadFile.mockRejectedValueOnce(new Error('Fatal S3 network fault'));

    await saveImpl(state);

    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('Fatal S3 network fault'));
  });

  it('runs runSave and runSaveOnly helper wrappers cleanly', async () => {
    await expect(runSave(false)).resolves.not.toThrow();
    await expect(runSaveOnly(false)).resolves.not.toThrow();
  });
});
