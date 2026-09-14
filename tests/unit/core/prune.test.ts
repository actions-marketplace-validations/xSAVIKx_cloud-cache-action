import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { compileKeyTemplate, type KeyTemplate } from '../../../src/core/keyTemplate';
import { pruneCaches } from '../../../src/core/prune';
import type { StorageContext } from '../../../src/storage/client';

const s3Mock = mockClient(S3Client);

const NOW = new Date(Date.UTC(2026, 8, 13, 12, 0, 0));
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY_MS);

const FEATURE = 'refs/heads/feature';
const MAIN = 'refs/heads/main';

const storage: StorageContext = {
  client: new S3Client({ region: 'us-east-1' }),
  bucket: 'bucket',
  providerConfig: { provider: 'seaweedfs', region: 'us-east-1', forcePathStyle: true },
};

function templateFor(
  overrides: Partial<Parameters<typeof compileKeyTemplate>[0]> = {}
): KeyTemplate {
  return compileKeyTemplate({
    pattern: '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}',
    repository: 'octo/app',
    prefix: '',
    scopedToRepository: true,
    scopedToRef: true,
    version: 'v1',
    archiveFilename: 'cache.tar.zst',
    env: {},
    ...overrides,
  });
}

function object(
  key: string,
  size: number,
  lastModified?: Date
): { Key: string; Size: number; LastModified?: Date } {
  return { Key: key, Size: size, LastModified: lastModified };
}

beforeEach(() => {
  s3Mock.reset();
});

describe('pruneCaches', () => {
  it('prunes only objects past the age cutoff and reports what it kept', async () => {
    const template = templateFor();
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        object('octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst', 100, daysAgo(10)),
        object('octo/app/refs%2Fheads%2Fmain/k2/v1/cache.tar.zst', 200, daysAgo(1)),
      ],
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectCommand).resolves({});

    const result = await pruneCaches(
      { storage, template },
      { olderThanDays: 5, ref: MAIN, dryRun: false, now: NOW }
    );

    expect(result).toEqual({
      pruned: [
        {
          key: 'octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst',
          size: 100,
          lastModified: daysAgo(10),
        },
      ],
      keptCount: 1,
      prunedBytes: 100,
      dryRun: false,
    });
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input).toMatchObject({
      Bucket: 'bucket',
      Key: 'octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst',
    });
    expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input).toMatchObject({
      Bucket: 'bucket',
      Prefix: 'octo/app/refs%2Fheads%2Fmain/',
    });
  });

  it('lists only the given ref by default, and every ref when none is given', async () => {
    const template = templateFor();
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        object('octo/app/refs%2Fheads%2Ffeature/k1/v1/cache.tar.zst', 10, daysAgo(10)),
        object('octo/app/refs%2Fheads%2Fmain/k2/v1/cache.tar.zst', 20, daysAgo(10)),
      ],
      IsTruncated: false,
    });

    const scoped = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: FEATURE, dryRun: true, now: NOW }
    );
    expect(s3Mock.commandCalls(ListObjectsV2Command).at(-1)?.args[0].input.Prefix).toBe(
      'octo/app/refs%2Fheads%2Ffeature/'
    );
    // The fake ignores Prefix; the key matcher still keeps the other ref out.
    expect(scoped.pruned.map((p) => p.key)).toEqual([
      'octo/app/refs%2Fheads%2Ffeature/k1/v1/cache.tar.zst',
    ]);

    const all = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, dryRun: true, now: NOW }
    );
    expect(s3Mock.commandCalls(ListObjectsV2Command).at(-1)?.args[0].input.Prefix).toBe(
      'octo/app/'
    );
    expect(all.pruned).toHaveLength(2);
  });

  it('only considers archive objects, leaving unrelated objects untouched', async () => {
    const template = templateFor();
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        object('octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst', 10, daysAgo(10)),
        object('octo/app/refs%2Fheads%2Fmain/k2/v1/cache.tar.gz', 10, daysAgo(10)),
        object('octo/app/refs%2Fheads%2Fmain/notes.txt', 10, daysAgo(10)),
        object('octo/app/refs%2Fheads%2Fmain/k3/v1/cache.tar.zst.tmp', 10, daysAgo(10)),
      ],
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectCommand).resolves({});

    const result = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW }
    );

    expect(result.pruned.map((p) => p.key).sort()).toEqual([
      'octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst',
      'octo/app/refs%2Fheads%2Fmain/k2/v1/cache.tar.gz',
    ]);
    const deletedKeys = s3Mock
      .commandCalls(DeleteObjectCommand)
      .map((call) => call.args[0].input.Key);
    expect(deletedKeys.sort()).toEqual([
      'octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst',
      'octo/app/refs%2Fheads%2Fmain/k2/v1/cache.tar.gz',
    ]);
  });

  it('deletes nothing on a dry run', async () => {
    const template = templateFor();
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [object('octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst', 100, daysAgo(10))],
      IsTruncated: false,
    });

    const result = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: MAIN, dryRun: true, now: NOW }
    );

    expect(result.dryRun).toBe(true);
    expect(result.pruned).toEqual([
      {
        key: 'octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst',
        size: 100,
        lastModified: daysAgo(10),
      },
    ]);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it.each([
    ['${key}/${archive_filename}', false],
    ['${ref}/${GITHUB_REPOSITORY}/${key}/${version}/${archive_filename}', true],
  ])('refuses to prune when %s leaves no fixed listing prefix', async (pattern, scoped) => {
    const template = compileKeyTemplate({
      pattern,
      repository: 'octo/app',
      prefix: '',
      scopedToRepository: scoped,
      scopedToRef: scoped,
      version: 'v1',
      archiveFilename: 'cache.tar.zst',
      env: {},
    });

    await expect(
      pruneCaches({ storage, template }, { olderThanDays: 1, dryRun: true, now: NOW })
    ).rejects.toThrow(
      'Refusing to prune: s3-key-pattern leaves no fixed prefix to list under, which would scan the whole bucket. Set "prefix", keep "scoped-to-repository" enabled, or set "ref" when the pattern starts with ${ref}.'
    );
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
  });

  it('follows continuation tokens across pages', async () => {
    const template = templateFor();
    const pages: Record<string, object> = {
      start: {
        Contents: [object('octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst', 10, daysAgo(10))],
        IsTruncated: true,
        NextContinuationToken: 't1',
      },
      t1: {
        Contents: [object('octo/app/refs%2Fheads%2Fmain/k2/v1/cache.tar.zst', 20, daysAgo(10))],
        IsTruncated: false,
      },
    };
    s3Mock
      .on(ListObjectsV2Command)
      .callsFake(
        (input: { ContinuationToken?: string }) => pages[input.ContinuationToken ?? 'start']
      );

    const result = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: MAIN, dryRun: true, now: NOW }
    );

    expect(result.pruned.map((p) => p.key).sort()).toEqual([
      'octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst',
      'octo/app/refs%2Fheads%2Fmain/k2/v1/cache.tar.zst',
    ]);
    const calls = s3Mock.commandCalls(ListObjectsV2Command).map((call) => call.args[0].input);
    expect(calls.map((input) => input.ContinuationToken)).toEqual([undefined, 't1']);
  });

  it('attempts every deletion and throws an aggregate error listing up to 5 failed keys', async () => {
    const template = templateFor();
    const keys = Array.from(
      { length: 7 },
      (_, i) => `octo/app/refs%2Fheads%2Fmain/k${i}/v1/cache.tar.zst`
    );
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: keys.map((key) => object(key, 10, daysAgo(10))),
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectCommand).callsFake((input: { Key: string }) => {
      throw new Error(`boom: ${input.Key}`);
    });

    const promise = pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW }
    );
    await expect(promise).rejects.toThrow('Failed to delete 7 cache object(s):');
    await expect(promise).rejects.toThrow('and 2 more');
    await expect(promise).rejects.toBeInstanceOf(AggregateError);
    // Every candidate was attempted even though all of them failed.
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(7);
  });

  it('respects the concurrency cap while deleting', async () => {
    const template = templateFor();
    const keys = Array.from(
      { length: 6 },
      (_, i) => `octo/app/refs%2Fheads%2Fmain/k${i}/v1/cache.tar.zst`
    );
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: keys.map((key) => object(key, 10, daysAgo(10))),
      IsTruncated: false,
    });
    let active = 0;
    let maxActive = 0;
    s3Mock.on(DeleteObjectCommand).callsFake(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return {};
    });

    await pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW, concurrency: 2 }
    );

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(6);
  });
});

describe('pruneCaches key matching', () => {
  const REPO = 'acme/app';
  const OLD = daysAgo(30);

  function templateWith(
    pattern: string,
    overrides: Partial<Parameters<typeof compileKeyTemplate>[0]> = {}
  ): KeyTemplate {
    // Compiled the way buildPruneTier compiles it: no version, the zstd archive filename.
    return compileKeyTemplate({
      pattern,
      repository: REPO,
      prefix: '',
      scopedToRepository: true,
      scopedToRef: true,
      version: '',
      archiveFilename: 'cache.tar.zst',
      env: {},
      ...overrides,
    });
  }

  function listing(keys: string[]): void {
    // The fake ignores Prefix, so every key below reaches the matcher.
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: keys.map((key) => object(key, 10, OLD)),
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectCommand).resolves({});
  }

  function deletedKeys(): string[] {
    return s3Mock
      .commandCalls(DeleteObjectCommand)
      .map((call) => call.args[0].input.Key as string)
      .sort();
  }

  it('A: keeps another repository whose name extends this one when ${ref} is glued to the repository', async () => {
    const template = templateWith(
      'builds/${GITHUB_REPOSITORY}-${ref}/${key}/${version}/${archive_filename}'
    );
    const own = 'builds/acme/app-refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    const ownOtherRef = 'builds/acme/app-refs%2Fheads%2Frelease/k/27747e0d22df7792/cache.tar.gz';
    const foreign = 'builds/acme/app-legacy-refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    listing([own, ownOtherRef, foreign]);

    const result = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, dryRun: false, now: NOW }
    );

    expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input.Prefix).toBe(
      'builds/acme/app-'
    );
    expect(deletedKeys()).toEqual([own, ownOtherRef].sort());
    expect(result.pruned.map((p) => p.key).sort()).toEqual([own, ownOtherRef].sort());
    expect(result.keptCount).toBe(0);
  });

  it('B: keeps other refs of the same repository when pruning one ref', async () => {
    const template = templateWith('${GITHUB_REPOSITORY}/${key}/${ref}/${archive_filename}');
    const own = 'acme/app/k/refs%2Fheads%2Fmain/cache.tar.zst';
    const ownSlashedKey = 'acme/app/Linux/npm/refs%2Fheads%2Fmain/cache.tar.gz';
    const otherRef = 'acme/app/k/refs%2Fheads%2Frelease/cache.tar.zst';
    listing([own, ownSlashedKey, otherRef]);

    await pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW }
    );

    expect(deletedKeys()).toEqual([own, ownSlashedKey].sort());
  });

  it('C: keeps another repository when ${key} precedes ${GITHUB_REPOSITORY}', async () => {
    const template = templateWith('shared/${key}/${GITHUB_REPOSITORY}/${archive_filename}');
    const own = 'shared/k/acme/app/cache.tar.zst';
    const foreign = 'shared/k/other/repo/cache.tar.zst';
    const foreignKeyNamedLikeUs = 'shared/acme/app/other/repo/cache.tar.zst';
    const foreignLongerName = 'shared/k/acme/app-legacy/cache.tar.zst';
    listing([own, foreign, foreignKeyNamedLikeUs, foreignLongerName]);

    await pruneCaches({ storage, template }, { olderThanDays: 1, dryRun: false, now: NOW });

    expect(deletedKeys()).toEqual([own]);
  });

  it('D: the default pattern with one ref deletes only that ref of this repository', async () => {
    const template = templateWith(
      '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}'
    );
    const own = 'acme/app/refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    const otherRef = 'acme/app/refs%2Fheads%2Ffeature/k/27747e0d22df7792/cache.tar.zst';
    const foreign = 'acme/app-legacy/refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    listing([own, otherRef, foreign]);

    await pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW }
    );

    expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input.Prefix).toBe(
      'acme/app/refs%2Fheads%2Fmain/'
    );
    expect(deletedKeys()).toEqual([own]);
  });

  it('D: the default pattern for every ref keeps another prefix and another repository', async () => {
    const template = templateWith(
      '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}'
    );
    const main = 'acme/app/refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    const feature = 'acme/app/refs%2Fheads%2Ffeature/Linux/k/27747e0d22df7792/cache.tar.gz';
    const otherPrefix = 'acme/app/web/refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    const foreign = 'acme/app-legacy/refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    listing([main, feature, otherPrefix, foreign]);

    await pruneCaches({ storage, template }, { olderThanDays: 1, dryRun: false, now: NOW });

    expect(deletedKeys()).toEqual([feature, main].sort());
  });

  it('never deletes a non-archive object or a key that does not fill the whole pattern', async () => {
    const template = templateWith(
      '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}'
    );
    const own = 'acme/app/refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    listing([
      own,
      'acme/app/refs%2Fheads%2Fmain/k/27747e0d22df7792/notes.txt',
      'acme/app/refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst.tmp',
      'acme/app/refs%2Fheads%2Fmain/k/27747e0d22df7792/my-cache.tar.zst',
      'acme/app/refs%2Fheads%2Fmain/cache.tar.zst',
      'acme/app/refs%2Fheads%2Fmain/k/cache.tar.zst',
    ]);

    const result = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW }
    );

    expect(deletedKeys()).toEqual([own]);
    expect(result.keptCount).toBe(0);
  });

  it('reports the same candidates on a dry run as a real run deletes', async () => {
    const template = templateWith(
      'builds/${GITHUB_REPOSITORY}-${ref}/${key}/${version}/${archive_filename}'
    );
    const own = 'builds/acme/app-refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    const foreign = 'builds/acme/app-legacy-refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    listing([own, foreign]);

    const dry = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, dryRun: true, now: NOW }
    );
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    const real = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, dryRun: false, now: NOW }
    );

    expect(dry.pruned.map((p) => p.key)).toEqual([own]);
    expect(real.pruned.map((p) => p.key)).toEqual(dry.pruned.map((p) => p.key));
    expect(deletedKeys()).toEqual([own]);
  });

  it('keeps other repositories when an all-refs pattern places ${ref} before the repository', async () => {
    const template = templateWith(
      'shared/${ref}/${GITHUB_REPOSITORY}/${key}/${version}/${archive_filename}'
    );
    const own = 'shared/refs%2Fheads%2Fmain/acme/app/k/27747e0d22df7792/cache.tar.zst';
    const foreign = 'shared/refs%2Fheads%2Fmain/other/repo/k/27747e0d22df7792/cache.tar.zst';
    const foreignKeyNamedLikeUs =
      'shared/refs%2Fheads%2Fmain/other/repo/acme/app/27747e0d22df7792/cache.tar.zst';
    listing([own, foreign, foreignKeyNamedLikeUs]);

    await pruneCaches({ storage, template }, { olderThanDays: 1, dryRun: false, now: NOW });

    expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input.Prefix).toBe('shared/');
    expect(deletedKeys()).toEqual([own]);
  });

  describe('refusals', () => {
    const repositoryMessage =
      'Refusing to prune: s3-key-pattern puts ${GITHUB_REPOSITORY} in a path segment with ${key}, ${version} or a preceding ${ref}, so other repositories\' caches could match. Separate ${GITHUB_REPOSITORY} from them with "/".';

    it.each([
      ['cache/${key}-${GITHUB_REPOSITORY}/${version}/${archive_filename}', undefined],
      ['cache/${GITHUB_REPOSITORY}${key}/${version}/${archive_filename}', undefined],
      ['cache/${GITHUB_REPOSITORY}-${version}/${key}/${archive_filename}', undefined],
      ['builds/${ref}-${GITHUB_REPOSITORY}/${key}/${version}/${archive_filename}', undefined],
      ['builds/${ref}-${GITHUB_REPOSITORY}/${key}/${version}/${archive_filename}', MAIN],
    ])('refuses %s (ref %s) when repositories cannot be told apart', async (pattern, ref) => {
      const template = templateWith(pattern);
      await expect(
        pruneCaches({ storage, template }, { olderThanDays: 1, ref, dryRun: false, now: NOW })
      ).rejects.toThrow(repositoryMessage);
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
    });

    it('refuses to prune one ref when ${ref} shares a segment with ${key}', async () => {
      const template = templateWith('${GITHUB_REPOSITORY}/${key}-${ref}/${archive_filename}');
      await expect(
        pruneCaches({ storage, template }, { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW })
      ).rejects.toThrow(
        'Refusing to prune ref "refs/heads/main": s3-key-pattern puts ${ref} in a path segment with ${key}, ${version} or another ${ref}, so other refs\' caches could match. Separate ${ref} from them with "/", or leave "ref" empty to prune every ref.'
      );
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
    });

    it('refuses a pattern with no ${archive_filename}', async () => {
      const template = templateWith('${GITHUB_REPOSITORY}/${ref}/${key}');
      await expect(
        pruneCaches({ storage, template }, { olderThanDays: 1, dryRun: false, now: NOW })
      ).rejects.toThrow(
        'Refusing to prune: s3-key-pattern has no ${archive_filename}, so cache archives cannot be told apart from other objects.'
      );
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
    });

    it('refuses to prune one ref when the pattern has no ${ref}', async () => {
      const template = templateWith('${GITHUB_REPOSITORY}/${key}/${archive_filename}');
      await expect(
        pruneCaches({ storage, template }, { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW })
      ).rejects.toThrow(
        'Refusing to prune ref "refs/heads/main": s3-key-pattern has no ${ref}, so every ref shares the same object keys. Leave "ref" empty to prune them all.'
      );
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
    });

    it('allows the repository glued before ${ref}, which ref encoding keeps unambiguous', async () => {
      const template = templateWith(
        'builds/${GITHUB_REPOSITORY}-${ref}/${key}/${version}/${archive_filename}'
      );
      listing([]);
      await expect(
        pruneCaches({ storage, template }, { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW })
      ).resolves.toMatchObject({ pruned: [] });
    });
  });
});
