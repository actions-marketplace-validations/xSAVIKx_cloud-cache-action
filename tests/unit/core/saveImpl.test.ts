import { jest } from '@jest/globals';
import { Inputs, State } from '../../../src/constants';
import type { SaveOutcome } from '../../../src/core/outcomes';
import type { S3Tier } from '../../../src/core/s3Tier';
import { MemoryState } from '../../support/memoryState';

const inputs = new Map<string, string>();
const outputs = new Map<string, string>();
// Like the real core.setFailed, which only sets process.exitCode.
const mockSetFailed = jest.fn<(message: string) => void>(() => {
  process.exitCode = 1;
});
const mockWarning = jest.fn<(message: string) => void>();
const mockBuildS3Tier =
  jest.fn<
    (
      config: unknown,
      env?: NodeJS.ProcessEnv,
      options?: { compression?: string }
    ) => Promise<S3Tier>
  >();
const mockSaveToS3 =
  jest.fn<
    (
      tier: S3Tier,
      primaryKey: string,
      patterns: readonly string[],
      chunkSize?: number
    ) => Promise<SaveOutcome>
  >();
const mockExistsInGitHub =
  jest.fn<(paths: readonly string[], key: string, crossOs: boolean) => Promise<boolean>>();
const mockSaveToGitHub =
  jest.fn<
    (
      paths: readonly string[],
      key: string,
      chunkSize: number | undefined,
      crossOs: boolean
    ) => Promise<SaveOutcome>
  >();

jest.unstable_mockModule('@actions/core', () => ({
  getInput: (name: string) => inputs.get(name) ?? '',
  setOutput: (name: string, value: string) => {
    outputs.set(name, value);
  },
  setFailed: mockSetFailed,
  info: jest.fn(),
  warning: mockWarning,
  debug: jest.fn(),
  saveState: jest.fn(),
  getState: () => '',
}));
jest.unstable_mockModule('../../../src/core/s3Tier', () => ({
  buildS3Tier: mockBuildS3Tier,
  saveToS3: mockSaveToS3,
}));
jest.unstable_mockModule('../../../src/core/githubTier', () => ({
  existsInGitHub: mockExistsInGitHub,
  saveToGitHub: mockSaveToGitHub,
}));

const { runSave, runSaveOnly, saveImpl } = await import('../../../src/core/saveImpl');

const tier = { storage: { providerConfig: { provider: 'seaweedfs' } } } as unknown as S3Tier;
const s3Info = { objectKey: 'octo/app/k/cache.tar.zst', size: 2048, etag: '"new"' };
const s3Saved: SaveOutcome = { kind: 'saved', s3: s3Info };
const githubSaved: SaveOutcome = { kind: 'saved' };
const githubSkipped: SaveOutcome = {
  kind: 'skipped',
  reason: 'GitHub Actions Cache did not save this key (see the messages above)',
};
const failure = (message: string): SaveOutcome => ({ kind: 'error', error: new Error(message) });

describe('saveImpl', () => {
  let state: MemoryState;

  beforeEach(() => {
    inputs.clear();
    outputs.clear();
    jest.clearAllMocks();
    state = new MemoryState();
    process.env.GITHUB_EVENT_NAME = 'push';
    inputs.set(Inputs.Key, 'Linux-npm-abc');
    inputs.set(Inputs.Path, '~/.npm');
    mockBuildS3Tier.mockResolvedValue(tier);
    mockSaveToS3.mockResolvedValue(s3Saved);
    mockExistsInGitHub.mockResolvedValue(false);
    mockSaveToGitHub.mockResolvedValue(githubSaved);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  describe('pure S3 mode', () => {
    it('saves to S3 and reports the object', async () => {
      inputs.set(Inputs.UploadChunkSize, '10485760');
      await expect(saveImpl(state)).resolves.toBe(2048);
      expect(mockSaveToS3).toHaveBeenCalledWith(tier, 'Linux-npm-abc', ['~/.npm'], 10485760);
      expect(Object.fromEntries(outputs)).toEqual({
        'cache-storage-provider': 'seaweedfs',
        'cache-s3-key': s3Info.objectKey,
        'cache-size': '2048',
        'cache-etag': '"new"',
        'cache-saved-sources': 's3',
      });
      expect(mockSaveToGitHub).not.toHaveBeenCalled();
    });

    it('builds the S3 tier with the compression method the restore step used', async () => {
      state.setState(State.CacheCompression, 'gzip');
      await saveImpl(state);
      expect(mockBuildS3Tier).toHaveBeenCalledWith(expect.anything(), process.env, {
        compression: 'gzip',
      });
    });

    it('skips when the restore step had an exact S3 hit', async () => {
      state.setState(State.CacheS3ExactHit, 'true');
      await saveImpl(state);
      expect(mockSaveToS3).not.toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('none');
    });

    it('still saves to S3 after an exact hit from the GitHub fallback', async () => {
      inputs.set(Inputs.UseFallback, 'true');
      state.setState(State.CacheGithubExactHit, 'true');
      state.setState(State.CacheMatchedKey, 'Linux-npm-abc');
      await saveImpl(state);
      expect(mockSaveToS3).toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('s3');
    });

    it('counts an existing object as saved', async () => {
      mockSaveToS3.mockResolvedValue({ kind: 'exists', s3: s3Info });
      await saveImpl(state);
      expect(outputs.get('cache-saved-sources')).toBe('s3');
    });

    it('does not fall back when no paths matched', async () => {
      inputs.set(Inputs.UseFallback, 'true');
      mockSaveToS3.mockResolvedValue({ kind: 'skipped', reason: 'no paths matched' });
      await saveImpl(state);
      expect(mockSaveToGitHub).not.toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('none');
    });

    it('warns without failing when S3 fails and there is no fallback', async () => {
      mockSaveToS3.mockResolvedValue(failure('SlowDown'));
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith('Failed to save cache to S3: SlowDown');
      expect(outputs.get('cache-saved-sources')).toBe('none');
      expect(mockSetFailed).not.toHaveBeenCalled();
    });

    it('saves to GitHub when S3 fails and use-fallback is set', async () => {
      inputs.set(Inputs.UseFallback, 'true');
      inputs.set(Inputs.EnableCrossOsArchive, 'true');
      mockSaveToS3.mockResolvedValue(failure('SlowDown'));
      await saveImpl(state);
      expect(mockSaveToGitHub).toHaveBeenCalledWith(['~/.npm'], 'Linux-npm-abc', undefined, true);
      expect(outputs.get('cache-saved-sources')).toBe('github');
    });

    it('reports no saved source, without a warning, when the GitHub fallback skips', async () => {
      inputs.set(Inputs.UseFallback, 'true');
      mockSaveToS3.mockResolvedValue(failure('SlowDown'));
      mockSaveToGitHub.mockResolvedValue(githubSkipped);
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledTimes(1);
      expect(mockWarning).toHaveBeenCalledWith('Failed to save cache to S3: SlowDown');
      expect(outputs.get('cache-saved-sources')).toBe('none');
    });

    it('warns without failing when S3 cannot be set up', async () => {
      mockBuildS3Tier.mockRejectedValue(new Error('Bucket name is required.'));
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith(
        'Save cache encountered error: Bucket name is required.'
      );
      expect(mockSetFailed).not.toHaveBeenCalled();
    });

    it('saves to GitHub when S3 cannot be set up and use-fallback is set', async () => {
      inputs.set(Inputs.UseFallback, 'true');
      mockBuildS3Tier.mockRejectedValue(new Error('Bucket name is required.'));
      await saveImpl(state);
      expect(mockSaveToGitHub).toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('github');
    });

    it('does nothing in read-only mode', async () => {
      state.setState(State.CacheReadOnly, 'true');
      await saveImpl(state);
      expect(mockBuildS3Tier).not.toHaveBeenCalled();
    });

    it('warns and skips when no key is available', async () => {
      inputs.delete(Inputs.Key);
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith('Key is not specified. Skipping cache save.');
      expect(mockBuildS3Tier).not.toHaveBeenCalled();
    });
  });

  describe('dual-cache mode', () => {
    beforeEach(() => {
      inputs.set(Inputs.DualCache, 'true');
    });

    it('backfills GitHub after an S3 hit once a live check finds the key missing there', async () => {
      state.setState(State.CacheS3ExactHit, 'true');
      await saveImpl(state);
      expect(mockSaveToS3).not.toHaveBeenCalled();
      expect(mockExistsInGitHub).toHaveBeenCalledWith(['~/.npm'], 'Linux-npm-abc', false);
      expect(mockSaveToGitHub).toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('s3,github');
    });

    it('does not re-upload to GitHub when the key is already there', async () => {
      mockExistsInGitHub.mockResolvedValue(true);
      await saveImpl(state);
      expect(mockSaveToS3).toHaveBeenCalled();
      expect(mockSaveToGitHub).not.toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('s3,github');
    });

    it('treats the removed independent strategy as backfill', async () => {
      inputs.set(Inputs.DualCacheStrategy, 'independent');
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith(
        expect.stringContaining('"independent" was removed')
      );
      expect(mockExistsInGitHub).toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('s3,github');
    });

    it('saves to neither tier after an exact hit with skip-on-hit', async () => {
      inputs.set(Inputs.DualCacheStrategy, 'skip-on-hit');
      state.setState(State.CacheGithubExactHit, 'true');
      await saveImpl(state);
      expect(mockSaveToS3).not.toHaveBeenCalled();
      expect(mockSaveToGitHub).not.toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('github');
    });

    it('warns about an S3 error and still saves to GitHub when not strict', async () => {
      mockSaveToS3.mockResolvedValue(failure('boom'));
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith('Dual-cache S3 save error: boom');
      expect(outputs.get('cache-saved-sources')).toBe('github');
      expect(mockSetFailed).not.toHaveBeenCalled();
    });

    it('fails the step on an S3 error when strict', async () => {
      inputs.set(Inputs.DualCacheStrict, 'true');
      mockSaveToS3.mockResolvedValue(failure('boom'));
      await saveImpl(state);
      expect(mockSetFailed).toHaveBeenCalledWith('Saving to S3 failed: boom');
      expect(mockSaveToGitHub).not.toHaveBeenCalled();
    });

    it('does not fail or warn in strict mode when GitHub skips the save', async () => {
      inputs.set(Inputs.DualCacheStrict, 'true');
      mockSaveToGitHub.mockResolvedValue(githubSkipped);
      await saveImpl(state);
      expect(mockSaveToGitHub).toHaveBeenCalled();
      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(mockWarning).not.toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('s3');
    });

    it('fails the step on a GitHub save error when strict', async () => {
      inputs.set(Inputs.DualCacheStrict, 'true');
      mockSaveToGitHub.mockResolvedValue(failure('quota exceeded'));
      await saveImpl(state);
      expect(mockSetFailed).toHaveBeenCalledWith(
        'Saving to GitHub Actions Cache failed: quota exceeded'
      );
    });

    it('fails the step when the strict GitHub existence check errors', async () => {
      inputs.set(Inputs.DualCacheStrict, 'true');
      mockExistsInGitHub.mockRejectedValue(new Error('cache service unavailable'));
      await saveImpl(state);
      expect(mockSetFailed).toHaveBeenCalledWith(
        'Saving to GitHub Actions Cache failed: cache service unavailable'
      );
    });

    it('fails the step when S3 cannot be set up in strict mode', async () => {
      inputs.set(Inputs.DualCacheStrict, 'true');
      mockBuildS3Tier.mockRejectedValue(new Error('Bucket name is required.'));
      await saveImpl(state);
      expect(mockSetFailed).toHaveBeenCalledWith('Bucket name is required.');
    });
  });

  it('runs the wrappers without exiting when earlyExit is false', async () => {
    await expect(runSave(false)).resolves.toBeUndefined();
    await expect(runSaveOnly(false)).resolves.toBeUndefined();
  });

  describe.each([
    ['runSave', runSave],
    ['runSaveOnly', runSaveOnly],
  ])('%s with earlyExit', (_name, run) => {
    let exitCodes: Array<string | number | null | undefined>;
    let exitSpy: { mockRestore(): void };

    beforeEach(() => {
      exitCodes = [];
      exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
        exitCodes.push(code);
      }) as (code?: string | number | null) => never);
    });

    afterEach(() => {
      exitSpy.mockRestore();
    });

    it('exits 1 after a strict dual-cache S3 save error', async () => {
      inputs.set(Inputs.DualCache, 'true');
      inputs.set(Inputs.DualCacheStrict, 'true');
      mockSaveToS3.mockResolvedValue(failure('AccessDenied'));
      await run(true);
      expect(mockSetFailed).toHaveBeenCalledWith('Saving to S3 failed: AccessDenied');
      expect(exitCodes).toEqual([1]);
    });

    it('exits 0 after a successful save', async () => {
      await run(true);
      expect(exitCodes).toEqual([0]);
    });

    it('exits 0 after a save error that is not strict', async () => {
      inputs.set(Inputs.DualCache, 'true');
      mockSaveToS3.mockResolvedValue(failure('AccessDenied'));
      await run(true);
      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(exitCodes).toEqual([0]);
    });
  });
});
