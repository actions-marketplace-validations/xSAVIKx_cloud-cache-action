import { jest } from '@jest/globals';

const mockSaveState = jest.fn<(k: string, v: string) => void>();
const mockGetState = jest.fn<(k: string) => string>();
const mockGetInput = jest.fn<(k: string, options?: unknown) => string>();

jest.unstable_mockModule('@actions/core', () => ({
  saveState: mockSaveState,
  getState: mockGetState,
  getInput: mockGetInput,
}));

const { Inputs, Outputs, State } = await import('../../src/constants');
const { StateProvider, NullStateProvider } = await import('../../src/state');
const {
  getInputAsArray,
  getInputAsBool,
  getInputAsInt,
  isExactKeyMatch,
} = await import('../../src/utils/inputUtils');

describe('API Contract Parity: actions/cache (v4, v5, v6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Inputs Specification Parity', () => {
    const activeCacheInputs = [
      'key',
      'path',
      'restore-keys',
      'upload-chunk-size',
      'enableCrossOsArchive',
      'fail-on-cache-miss',
      'lookup-only',
      'save-always',
      'read-only',
    ];

    it.each(activeCacheInputs)(
      'supports official input "%s"',
      (inputName) => {
        const values = Object.values(Inputs);
        expect(values).toContain(inputName);
      }
    );
  });

  describe('Outputs Specification Parity', () => {
    const officialOutputs = [
      'cache-hit',
      'cache-primary-key',
      'cache-matched-key',
    ];

    it.each(officialOutputs)(
      'provides official output "%s"',
      (outputName) => {
        const values = Object.values(Outputs);
        expect(values).toContain(outputName);
      }
    );

    it('provides extended cloud provider diagnostics', () => {
      expect(Outputs.CacheSize).toBe('cache-size');
      expect(Outputs.CacheStorageProvider).toBe('cache-storage-provider');
      expect(Outputs.CacheS3Key).toBe('cache-s3-key');
      expect(Outputs.CacheETag).toBe('cache-etag');
    });
  });

  describe('State Management Parity', () => {
    it('StateProvider stores and restores keys matching actions/cache state lifecycle', () => {
      const stateMap = new Map<string, string>();
      mockSaveState.mockImplementation((k: string, v: string) => {
        stateMap.set(k, v);
      });
      mockGetState.mockImplementation((k: string) => stateMap.get(k) || '');

      const provider = new StateProvider();
      provider.setState(State.CachePrimaryKey, 'test-primary-key');
      provider.setState(State.CacheMatchedKey, 'test-matched-key');

      expect(provider.getState(State.CachePrimaryKey)).toBe('test-primary-key');
      expect(provider.getCacheState()).toBe('test-matched-key');
      expect(mockSaveState).toHaveBeenCalledWith(
        State.CachePrimaryKey,
        'test-primary-key'
      );
    });

    it('NullStateProvider isolates state in standalone restore/save runs', () => {
      const provider = new NullStateProvider();
      provider.setState(State.CachePrimaryKey, 'standalone-key');

      expect(provider.getState(State.CachePrimaryKey)).toBe('standalone-key');
      expect(mockSaveState).not.toHaveBeenCalled();
    });
  });

  describe('Input Parser Semantics Parity', () => {
    it('parses multiline paths identical to actions/cache', () => {
      mockGetInput.mockReturnValue(
        '  node_modules \n\n .cache \n dist/**/*.js  '
      );
      const paths = getInputAsArray(Inputs.Path);
      expect(paths).toEqual(['node_modules', '.cache', 'dist/**/*.js']);
    });

    it('parses booleans with case-insensitivity', () => {
      mockGetInput
        .mockReturnValueOnce('TRUE')
        .mockReturnValueOnce('false')
        .mockReturnValueOnce('');

      expect(getInputAsBool(Inputs.LookupOnly)).toBe(true);
      expect(getInputAsBool(Inputs.FailOnCacheMiss)).toBe(false);
      expect(getInputAsBool(Inputs.EnableCrossOsArchive, false)).toBe(false);
    });

    it('parses integer upload-chunk-size', () => {
      mockGetInput
        .mockReturnValueOnce('10485760')
        .mockReturnValueOnce('invalid')
        .mockReturnValueOnce('');

      expect(getInputAsInt(Inputs.UploadChunkSize)).toBe(10485760);
      expect(getInputAsInt(Inputs.UploadChunkSize, 500)).toBe(500);
      expect(getInputAsInt(Inputs.UploadChunkSize)).toBeUndefined();
    });

    it('exact key match helper is case-insensitive and trims whitespace', () => {
      expect(isExactKeyMatch('Linux-Node-18-abc', ' linux-node-18-abc ')).toBe(
        true
      );
      expect(isExactKeyMatch('Linux-Node-18-abc', 'Linux-Node-18-xyz')).toBe(
        false
      );
      expect(isExactKeyMatch('Linux-Node-18-abc', undefined)).toBe(false);
    });
  });
});
