import { jest } from '@jest/globals';

type RestoreCache = (
  paths: string[],
  primaryKey: string,
  restoreKeys?: string[],
  options?: { lookupOnly?: boolean },
  enableCrossOsArchive?: boolean
) => Promise<string | undefined>;
type SaveCache = (
  paths: string[],
  key: string,
  options?: { uploadChunkSize?: number },
  enableCrossOsArchive?: boolean
) => Promise<number>;

const mockRestoreCache = jest.fn<RestoreCache>();
const mockSaveCache = jest.fn<SaveCache>();

jest.unstable_mockModule('@actions/cache', () => ({
  restoreCache: mockRestoreCache,
  saveCache: mockSaveCache,
}));

const { existsInGitHub, restoreFromGitHub, saveToGitHub } = await import(
  '../../../src/core/githubTier'
);

describe('restoreFromGitHub', () => {
  it('reports an exact hit and passes every option through', async () => {
    mockRestoreCache.mockResolvedValue('Linux-npm-abc');
    await expect(
      restoreFromGitHub(['~/.npm'], 'Linux-npm-abc', ['Linux-npm-'], false, true)
    ).resolves.toEqual({ kind: 'hit', matchedKey: 'Linux-npm-abc', exact: true });
    expect(mockRestoreCache).toHaveBeenCalledWith(
      ['~/.npm'],
      'Linux-npm-abc',
      ['Linux-npm-'],
      { lookupOnly: false },
      true
    );
  });

  it('reports a restore-key match as a partial hit', async () => {
    mockRestoreCache.mockResolvedValue('Linux-npm-old');
    await expect(
      restoreFromGitHub(['a'], 'Linux-npm-abc', ['Linux-npm-'], true, false)
    ).resolves.toEqual({
      kind: 'hit',
      matchedKey: 'Linux-npm-old',
      exact: false,
    });
  });

  it('reports a miss', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    await expect(restoreFromGitHub(['a'], 'k', [], false, false)).resolves.toEqual({
      kind: 'miss',
    });
  });

  it('returns failures instead of throwing', async () => {
    const error = new Error('Cache service responded with 503');
    mockRestoreCache.mockRejectedValue(error);
    await expect(restoreFromGitHub(['a'], 'k', [], false, false)).resolves.toEqual({
      kind: 'error',
      error,
    });
  });
});

describe('existsInGitHub', () => {
  it('is true only for an exact key, using a lookup-only restore', async () => {
    mockRestoreCache.mockResolvedValue('k');
    await expect(existsInGitHub(['a'], 'k', true)).resolves.toBe(true);
    expect(mockRestoreCache).toHaveBeenCalledWith(['a'], 'k', [], { lookupOnly: true }, true);
  });

  it('does not count a prefix match as already present', async () => {
    mockRestoreCache.mockResolvedValue('k-older');
    await expect(existsInGitHub(['a'], 'k', false)).resolves.toBe(false);
  });

  it('is false on a miss', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    await expect(existsInGitHub(['a'], 'k', false)).resolves.toBe(false);
  });

  it('lets service failures propagate', async () => {
    mockRestoreCache.mockRejectedValue(new Error('unavailable'));
    await expect(existsInGitHub(['a'], 'k', false)).rejects.toThrow('unavailable');
  });
});

describe('saveToGitHub', () => {
  it('reports a saved cache and passes the chunk size through', async () => {
    mockSaveCache.mockResolvedValue(42);
    await expect(saveToGitHub(['a'], 'k', 1024, true)).resolves.toEqual({ kind: 'saved' });
    expect(mockSaveCache).toHaveBeenCalledWith(['a'], 'k', { uploadChunkSize: 1024 }, true);
  });

  it('treats the -1 cache id as skipped, because @actions/cache already logged why', async () => {
    mockSaveCache.mockResolvedValue(-1);
    await expect(saveToGitHub(['a'], 'k', undefined, false)).resolves.toEqual({
      kind: 'skipped',
      reason: 'GitHub Actions Cache did not save this key (see the messages above)',
    });
  });

  it('returns thrown failures', async () => {
    mockSaveCache.mockRejectedValue('quota exceeded');
    const outcome = await saveToGitHub(['a'], 'k', undefined, false);
    expect(outcome.kind === 'error' && outcome.error.message).toBe('quota exceeded');
  });

  it('treats a path validation error as skipped, consistent with the S3 tier', async () => {
    const error = new Error(
      'Path Validation Error: At least one directory or file path is required'
    );
    error.name = 'ValidationError';
    mockSaveCache.mockRejectedValue(error);
    await expect(saveToGitHub(['a'], 'k', undefined, false)).resolves.toEqual({
      kind: 'skipped',
      reason: 'no paths matched',
    });
  });

  it('still reports another validation error as an error', async () => {
    const error = new Error('Key Validation Error: k cannot contain commas.');
    error.name = 'ValidationError';
    mockSaveCache.mockRejectedValue(error);
    const outcome = await saveToGitHub(['a'], 'k', undefined, false);
    expect(outcome).toEqual({ kind: 'error', error });
  });
});
