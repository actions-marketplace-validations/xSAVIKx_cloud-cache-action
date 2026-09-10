import { Inputs, Outputs, State } from '../../src/constants';
import { StateProvider, NullStateProvider } from '../../src/state';
import {
  getInputAsArray,
  getInputAsBool,
  getInputAsInt,
  isExactKeyMatch,
} from '../../src/utils/inputUtils';
import * as core from '@actions/core';

jest.mock('@actions/core');

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
      (core.saveState as jest.Mock).mockImplementation((k, v) =>
        stateMap.set(k, v)
      );
      (core.getState as jest.Mock).mockImplementation((k) =>
        stateMap.get(k) || ''
      );

      const provider = new StateProvider();
      provider.setState(State.CachePrimaryKey, 'test-primary-key');
      provider.setState(State.CacheMatchedKey, 'test-matched-key');

      expect(provider.getState(State.CachePrimaryKey)).toBe('test-primary-key');
      expect(provider.getCacheState()).toBe('test-matched-key');
      expect(core.saveState).toHaveBeenCalledWith(
        State.CachePrimaryKey,
        'test-primary-key'
      );
    });

    it('NullStateProvider isolates state in standalone restore/save runs', () => {
      const provider = new NullStateProvider();
      provider.setState(State.CachePrimaryKey, 'standalone-key');

      expect(provider.getState(State.CachePrimaryKey)).toBe('standalone-key');
      expect(core.saveState).not.toHaveBeenCalled();
    });
  });

  describe('Input Parser Semantics Parity', () => {
    it('parses multiline paths identical to actions/cache', () => {
      (core.getInput as jest.Mock).mockReturnValue(
        '  node_modules \n\n .cache \n dist/**/*.js  '
      );
      const paths = getInputAsArray(Inputs.Path);
      expect(paths).toEqual(['node_modules', '.cache', 'dist/**/*.js']);
    });

    it('parses booleans with case-insensitivity', () => {
      (core.getInput as jest.Mock)
        .mockReturnValueOnce('TRUE')
        .mockReturnValueOnce('false')
        .mockReturnValueOnce('');

      expect(getInputAsBool(Inputs.LookupOnly)).toBe(true);
      expect(getInputAsBool(Inputs.FailOnCacheMiss)).toBe(false);
      expect(getInputAsBool(Inputs.EnableCrossOsArchive, false)).toBe(false);
    });

    it('parses integer upload-chunk-size', () => {
      (core.getInput as jest.Mock)
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
