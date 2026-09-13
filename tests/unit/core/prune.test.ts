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
    // The in-memory fake ignores Prefix, so this only verifies dry-run listing/reporting.
    expect(scoped.pruned.map((p) => p.key)).toEqual([
      'octo/app/refs%2Fheads%2Ffeature/k1/v1/cache.tar.zst',
      'octo/app/refs%2Fheads%2Fmain/k2/v1/cache.tar.zst',
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

  it('refuses to prune when the resolved prefix is empty', async () => {
    const template = compileKeyTemplate({
      pattern: '${key}/${archive_filename}',
      repository: 'octo/app',
      prefix: '',
      scopedToRepository: false,
      scopedToRef: false,
      version: 'v1',
      archiveFilename: 'cache.tar.zst',
      env: {},
    });

    await expect(
      pruneCaches({ storage, template }, { olderThanDays: 1, dryRun: true, now: NOW })
    ).rejects.toThrow(
      'Refusing to prune: the resolved prefix is empty, which would scan the whole bucket. Set "prefix" or keep "scoped-to-repository" enabled.'
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
