import { jest } from '@jest/globals';
import { Inputs } from '../../../src/constants';
import type { PruneResult, PruneTier } from '../../../src/core/prune';
import type { StorageContext } from '../../../src/storage/client';

const inputs = new Map<string, string>();
const outputs = new Map<string, string>();
// Like the real core.setFailed, which only sets process.exitCode.
const mockSetFailed = jest.fn<(message: string) => void>(() => {
  process.exitCode = 1;
});
const mockWarning = jest.fn<(message: string) => void>();
const mockInfo = jest.fn<(message: string) => void>();
const mockCreateStorageContext = jest.fn<(options: { maxAttempts: number }) => StorageContext>();
const mockPruneCaches =
  jest.fn<(tier: PruneTier, options: Record<string, unknown>) => Promise<PruneResult>>();

jest.unstable_mockModule('@actions/core', () => ({
  getInput: (name: string) => inputs.get(name) ?? '',
  setOutput: (name: string, value: string) => {
    outputs.set(name, value);
  },
  setFailed: mockSetFailed,
  info: mockInfo,
  warning: mockWarning,
  debug: jest.fn(),
}));
jest.unstable_mockModule('../../../src/storage/client', () => ({
  createStorageContext: mockCreateStorageContext,
}));
jest.unstable_mockModule('../../../src/core/prune', () => ({
  pruneCaches: mockPruneCaches,
}));

const { pruneImpl, runPrune } = await import('../../../src/core/pruneImpl');

const storage: StorageContext = {
  client: {} as StorageContext['client'],
  bucket: 'bucket',
  providerConfig: { provider: 'seaweedfs', region: 'us-east-1', forcePathStyle: true },
};

const emptyResult: PruneResult = { pruned: [], keptCount: 0, prunedBytes: 0, dryRun: true };

describe('pruneImpl', () => {
  beforeEach(() => {
    inputs.clear();
    outputs.clear();
    jest.clearAllMocks();
    process.exitCode = undefined;
    process.env.GITHUB_REPOSITORY = 'octo/app';
    inputs.set(Inputs.Bucket, 'bucket');
    inputs.set(Inputs.OlderThanDays, '7');
    mockCreateStorageContext.mockReturnValue(storage);
    mockPruneCaches.mockResolvedValue(emptyResult);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('parses inputs and reports the outputs pruneCaches returns', async () => {
    inputs.set(Inputs.OlderThanDays, '30');
    inputs.set(Inputs.Ref, 'refs/heads/main');
    inputs.set(Inputs.DryRun, 'true');
    mockPruneCaches.mockResolvedValue({
      pruned: [{ key: 'octo/app/refs%2Fheads%2Fmain/k1/cache.tar.zst', size: 100 }],
      keptCount: 2,
      prunedBytes: 100,
      dryRun: true,
    });

    await pruneImpl();

    expect(mockPruneCaches).toHaveBeenCalledWith(
      { storage, template: expect.anything() },
      expect.objectContaining({ olderThanDays: 30, ref: 'refs/heads/main', dryRun: true })
    );
    expect(Object.fromEntries(outputs)).toEqual({
      'pruned-count': '1',
      'pruned-bytes': '100',
      'kept-count': '2',
    });
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it('treats an empty ref input as pruning every ref', async () => {
    inputs.set(Inputs.Ref, '');
    await pruneImpl();
    expect(mockPruneCaches).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ref: undefined })
    );
  });

  it('defaults dry-run to false', async () => {
    await pruneImpl();
    expect(mockPruneCaches).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dryRun: false })
    );
  });

  it.each(['True', 'TRUE', 'true'])('accepts %s as a valid true dry-run value', async (value) => {
    inputs.set(Inputs.DryRun, value);
    await pruneImpl();
    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockPruneCaches).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dryRun: true })
    );
  });

  it.each(['False', 'FALSE', 'false'])(
    'accepts %s as a valid false dry-run value',
    async (value) => {
      inputs.set(Inputs.DryRun, value);
      await pruneImpl();
      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(mockPruneCaches).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ dryRun: false })
      );
    }
  );

  it.each(['Flase', 'yes', '1', 'no', 'TrUe'])(
    'fails on an unrecognized dry-run value instead of silently defaulting to a real deletion (%s)',
    async (value) => {
      inputs.set(Inputs.DryRun, value);
      await pruneImpl();
      expect(mockSetFailed).toHaveBeenCalledWith(
        `Invalid "dry-run" value "${value}": use true or false.`
      );
      expect(mockCreateStorageContext).not.toHaveBeenCalled();
      expect(mockPruneCaches).not.toHaveBeenCalled();
    }
  );

  it('fails when older-than-days is missing', async () => {
    inputs.delete(Inputs.OlderThanDays);
    await pruneImpl();
    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('older-than-days'));
    expect(mockPruneCaches).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', 'abc', '1.5'])(
    'fails when older-than-days is not a positive integer (%s)',
    async (value) => {
      inputs.set(Inputs.OlderThanDays, value);
      await pruneImpl();
      expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('older-than-days'));
      expect(mockPruneCaches).not.toHaveBeenCalled();
    }
  );

  it('fails the step when pruneCaches throws', async () => {
    mockPruneCaches.mockRejectedValue(new Error('boom'));
    await pruneImpl();
    expect(mockSetFailed).toHaveBeenCalledWith('boom');
  });

  it('fails when the storage context cannot be built', async () => {
    mockCreateStorageContext.mockImplementation(() => {
      throw new Error('Bucket name is required.');
    });
    await pruneImpl();
    expect(mockSetFailed).toHaveBeenCalledWith('Bucket name is required.');
    expect(mockPruneCaches).not.toHaveBeenCalled();
  });

  describe('the ref-before-repository/prefix safety guard', () => {
    const dangerousMessage =
      'Refusing to prune all refs: s3-key-pattern places ${ref} before the repository or prefix, so the listing would include other repositories\' caches. Set the "ref" input to prune a single ref.';

    it('refuses an all-refs prune when ${ref} comes before ${GITHUB_REPOSITORY}', async () => {
      inputs.set(Inputs.S3KeyPattern, '${ref}/${GITHUB_REPOSITORY}/${key}/${archive_filename}');
      await pruneImpl();
      expect(mockSetFailed).toHaveBeenCalledWith(dangerousMessage);
      expect(mockPruneCaches).not.toHaveBeenCalled();
    });

    it('refuses an all-refs prune when ${ref} comes before ${prefix} and prefix is set', async () => {
      inputs.set(Inputs.ScopedToRepository, 'false');
      inputs.set(Inputs.Prefix, 'shared/');
      inputs.set(Inputs.S3KeyPattern, '${ref}/${prefix}${key}/${archive_filename}');
      await pruneImpl();
      expect(mockSetFailed).toHaveBeenCalledWith(dangerousMessage);
      expect(mockPruneCaches).not.toHaveBeenCalled();
    });

    it('allows the same repository-order pattern when a single ref is set', async () => {
      inputs.set(Inputs.S3KeyPattern, '${ref}/${GITHUB_REPOSITORY}/${key}/${archive_filename}');
      inputs.set(Inputs.Ref, 'refs/heads/main');
      await pruneImpl();
      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(mockPruneCaches).toHaveBeenCalled();
    });

    it('allows the same prefix-order pattern when a single ref is set', async () => {
      inputs.set(Inputs.ScopedToRepository, 'false');
      inputs.set(Inputs.Prefix, 'shared/');
      inputs.set(Inputs.S3KeyPattern, '${ref}/${prefix}${key}/${archive_filename}');
      inputs.set(Inputs.Ref, 'refs/heads/main');
      await pruneImpl();
      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(mockPruneCaches).toHaveBeenCalled();
    });

    it('does not refuse when prefix is empty even if ${ref} precedes ${prefix}', async () => {
      inputs.set(Inputs.ScopedToRepository, 'false');
      inputs.set(Inputs.S3KeyPattern, '${ref}/${prefix}${key}/${archive_filename}');
      await pruneImpl();
      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(mockPruneCaches).toHaveBeenCalled();
    });

    it('does not refuse the default pattern, which places ${ref} after the repository and prefix', async () => {
      await pruneImpl();
      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(mockPruneCaches).toHaveBeenCalled();
    });
  });

  it('runs the wrapper without exiting when earlyExit is false', async () => {
    await expect(runPrune(false)).resolves.toBeUndefined();
  });

  it('exits 0 from the wrapper after a successful prune', async () => {
    const exitCodes: Array<string | number | null | undefined> = [];
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null
    ) => {
      exitCodes.push(code);
    }) as (code?: string | number | null) => never);
    try {
      await runPrune(true);
    } finally {
      exitSpy.mockRestore();
    }
    expect(exitCodes).toEqual([0]);
  });

  it('exits 1 from the wrapper after a failed prune', async () => {
    inputs.delete(Inputs.OlderThanDays);
    const exitCodes: Array<string | number | null | undefined> = [];
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null
    ) => {
      exitCodes.push(code);
    }) as (code?: string | number | null) => never);
    try {
      await runPrune(true);
    } finally {
      exitSpy.mockRestore();
    }
    expect(exitCodes).toEqual([1]);
  });
});
