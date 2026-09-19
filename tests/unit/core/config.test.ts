import { jest } from '@jest/globals';
import { Defaults, Inputs, State } from '../../../src/constants';
import { MemoryState } from '../../support/memoryState';

const inputs = new Map<string, string>();
const mockWarning = jest.fn<(message: string) => void>();

jest.unstable_mockModule('@actions/core', () => ({
  getInput: (name: string) => inputs.get(name) ?? '',
  warning: mockWarning,
}));

const { persistCacheConfig, readCacheConfig } = await import('../../../src/core/config');

describe('readCacheConfig', () => {
  beforeEach(() => {
    inputs.clear();
    mockWarning.mockReset();
    inputs.set(Inputs.Key, 'Linux-npm-abc');
    inputs.set(Inputs.Path, '~/.npm\nnode_modules');
  });

  it('applies the action defaults when optional inputs are empty', () => {
    expect(readCacheConfig()).toEqual({
      primaryKey: 'Linux-npm-abc',
      paths: ['~/.npm', 'node_modules'],
      restoreKeys: [],
      lookupOnly: false,
      failOnCacheMiss: false,
      readOnly: false,
      enableCrossOsArchive: false,
      uploadChunkSize: undefined,
      s3KeyPattern: Defaults.DefaultS3KeyPattern,
      prefix: '',
      scopedToRepository: true,
      scopedToRef: true,
      retryEnabled: true,
      retryCount: 3,
      useFallback: false,
      dualCache: false,
      restorePriority: 's3-first',
      dualCacheStrategy: 'backfill',
      dualCacheStrict: false,
      streaming: false,
      jobSummary: true,
      metadata: {},
      tags: [],
    });
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it('reads the streaming input', () => {
    inputs.set(Inputs.Streaming, 'true');
    expect(readCacheConfig().streaming).toBe(true);
  });

  it('honours retry-count: 0', () => {
    inputs.set(Inputs.RetryCount, '0');
    expect(readCacheConfig().retryCount).toBe(0);
  });

  it('warns and uses the default for an unknown restore-priority', () => {
    inputs.set(Inputs.RestorePriority, 'S3-FIRST');
    expect(readCacheConfig().restorePriority).toBe('s3-first');
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('restore-priority'));
  });

  it('maps the removed independent strategy to backfill with a single warning', () => {
    inputs.set(Inputs.DualCacheStrategy, 'independent');
    expect(readCacheConfig().dualCacheStrategy).toBe('backfill');
    expect(mockWarning).toHaveBeenCalledTimes(1);
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('"independent" was removed'));
  });

  it('warns and uses the default for an invalid boolean', () => {
    inputs.set(Inputs.ScopedToRef, 'yes');
    expect(readCacheConfig().scopedToRef).toBe(true);
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('scoped-to-ref'));
  });

  it('prefers what the restore step persisted over post-step inputs', () => {
    const state = new MemoryState();
    persistCacheConfig(state, {
      ...readCacheConfig(),
      primaryKey: 'restored-key',
      retryCount: 0,
      scopedToRef: false,
      dualCacheStrategy: 'skip-on-hit',
      restorePriority: 'github-first',
      readOnly: true,
      streaming: true,
    });
    inputs.set(Inputs.Key, 'post-step-key');
    inputs.set(Inputs.DualCacheStrategy, 'independent');
    inputs.set(Inputs.RestorePriority, 'bogus');
    inputs.set(Inputs.Streaming, 'false');

    expect(readCacheConfig(state)).toMatchObject({
      primaryKey: 'restored-key',
      retryCount: 0,
      scopedToRef: false,
      dualCacheStrategy: 'skip-on-hit',
      restorePriority: 'github-first',
      readOnly: true,
      streaming: true,
    });
    expect(mockWarning).not.toHaveBeenCalled();
  });
});

describe('metadata and tags inputs', () => {
  beforeEach(() => {
    inputs.clear();
    mockWarning.mockReset();
    inputs.set(Inputs.Key, 'Linux-npm-abc');
    inputs.set(Inputs.Path, '~/.npm\nnode_modules');
  });

  it('default to empty', () => {
    const config = readCacheConfig();
    expect(config.metadata).toEqual({});
    expect(config.tags).toEqual([]);
  });

  it('are parsed from the inputs and persisted as JSON for the post step', () => {
    inputs.set(Inputs.Metadata, 'team=platform\nbuild=42');
    inputs.set(Inputs.Tags, 'repo=acme/app');
    const state = new MemoryState();
    const config = readCacheConfig();
    persistCacheConfig(state, config);
    expect(state.getState(State.CacheMetadata)).toBe('{"team":"platform","build":"42"}');
    expect(state.getState(State.CacheTags)).toBe('[{"Key":"repo","Value":"acme/app"}]');

    inputs.delete(Inputs.Metadata);
    inputs.delete(Inputs.Tags);
    const post = readCacheConfig(state);
    expect(post.metadata).toEqual({ team: 'platform', build: '42' });
    expect(post.tags).toEqual([{ Key: 'repo', Value: 'acme/app' }]);
  });

  it('fails on an invalid value', () => {
    inputs.set(Inputs.Metadata, 'cloud-cache-x=1');
    expect(() => readCacheConfig()).toThrow('reserved');
  });
});
