import { jest } from '@jest/globals';

const mockRestoreCache =
  jest.fn<
    (
      paths: string[],
      primaryKey: string,
      restoreKeys?: string[],
      options?: { lookupOnly?: boolean },
      enableCrossOsArchive?: boolean
    ) => Promise<string | undefined>
  >();

const mockSaveCache =
  jest.fn<
    (
      paths: string[],
      key: string,
      options?: { uploadChunkSize?: number },
      enableCrossOsArchive?: boolean
    ) => Promise<number>
  >();

const mockInfo = jest.fn<(msg: string) => void>();
const mockWarning = jest.fn<(msg: string) => void>();

jest.unstable_mockModule('@actions/cache', () => ({
  restoreCache: mockRestoreCache,
  saveCache: mockSaveCache,
}));

jest.unstable_mockModule('@actions/core', () => ({
  info: mockInfo,
  warning: mockWarning,
}));

const { fallbackRestore, fallbackSave } = await import('../../src/utils/fallback');

describe('GitHub Actions Cache Fallback Helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fallbackRestore', () => {
    it('successfully restores cache from official service and returns matched key', async () => {
      mockRestoreCache.mockResolvedValueOnce('my-cache-key-v1');

      const result = await fallbackRestore(['build/'], 'my-cache-key-v1', ['my-cache-key-'], {
        lookupOnly: false,
      });

      expect(result).toBe('my-cache-key-v1');
      expect(mockRestoreCache).toHaveBeenCalledWith(
        ['build/'],
        'my-cache-key-v1',
        ['my-cache-key-'],
        { lookupOnly: false },
        undefined
      );
      expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Attempting fallback restore'));
    });

    it('catches and logs warning when restoreCache fails, returning undefined', async () => {
      mockRestoreCache.mockRejectedValueOnce(new Error('Cache service unavailable (503)'));

      const result = await fallbackRestore(['build/'], 'key-1', []);

      expect(result).toBeUndefined();
      expect(mockWarning).toHaveBeenCalledWith(
        expect.stringContaining('Cache service unavailable (503)')
      );
    });
  });

  describe('fallbackSave', () => {
    it('successfully saves cache to official service and returns cacheId', async () => {
      mockSaveCache.mockResolvedValueOnce(42);

      const result = await fallbackSave(['dist/'], 'prod-cache-v1', { uploadChunkSize: 32 }, true);

      expect(result).toBe(42);
      expect(mockSaveCache).toHaveBeenCalledWith(
        ['dist/'],
        'prod-cache-v1',
        { uploadChunkSize: 32 },
        true
      );
    });

    it('catches and logs warning when saveCache fails, returning undefined', async () => {
      mockSaveCache.mockRejectedValueOnce(new Error('Quota exceeded (400)'));

      const result = await fallbackSave(['dist/'], 'prod-cache-v1');

      expect(result).toBeUndefined();
      expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('Quota exceeded (400)'));
    });
  });
});
