import { jest } from '@jest/globals';
import type { S3Client } from '@aws-sdk/client-s3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CompressionConfig } from '../../../src/archive/compression';
import type { ResolvedCachePaths } from '../../../src/archive/paths';
import type { CacheConfig } from '../../../src/core/config';
import { compileKeyTemplate } from '../../../src/core/keyTemplate';
import { computeCacheVersion } from '../../../src/core/version';
import type { StorageContext } from '../../../src/storage/client';
import type { CacheObjectMetadata } from '../../../src/storage/operations';
import { makeTempDir, removeDir } from '../../support/tempTree';

const mockWarning = jest.fn<(message: string) => void>();
const mockCreateStorageContext = jest.fn<(options: { maxAttempts: number }) => StorageContext>();
const mockGetCompressionConfig = jest.fn<() => Promise<CompressionConfig>>();
const mockResolveCachePaths =
  jest.fn<(patterns: readonly string[], workspace?: string) => Promise<ResolvedCachePaths>>();
const mockCreateArchive =
  jest.fn<
    (
      archivePath: string,
      entries: readonly string[],
      compression: CompressionConfig,
      workspace: string
    ) => Promise<void>
  >();
const mockExtractArchive =
  jest.fn<
    (archivePath: string, compression: CompressionConfig, workspace: string) => Promise<void>
  >();
const mockGetArchiveSize = jest.fn<(archivePath: string) => number>();
const mockCheckObjectExists =
  jest.fn<(client: S3Client, bucket: string, key: string) => Promise<CacheObjectMetadata | null>>();
const mockFindNewestObject =
  jest.fn<
    (
      client: S3Client,
      bucket: string,
      prefix: string,
      accept: (key: string) => boolean
    ) => Promise<CacheObjectMetadata | undefined>
  >();
const mockDownloadFile =
  jest.fn<(client: S3Client, bucket: string, key: string, destination: string) => Promise<void>>();
const mockUploadFile =
  jest.fn<
    (
      client: S3Client,
      bucket: string,
      key: string,
      source: string,
      chunkSize?: number
    ) => Promise<{ size: number; etag?: string }>
  >();

jest.unstable_mockModule('@actions/core', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warning: mockWarning,
}));
jest.unstable_mockModule('../../../src/storage/client', () => ({
  createStorageContext: mockCreateStorageContext,
}));
jest.unstable_mockModule('../../../src/archive/compression', () => ({
  getCompressionConfig: mockGetCompressionConfig,
}));
jest.unstable_mockModule('../../../src/archive/paths', () => ({
  resolveCachePaths: mockResolveCachePaths,
  getWorkspace: (env: NodeJS.ProcessEnv = process.env) => env.GITHUB_WORKSPACE || '/ws',
}));
jest.unstable_mockModule('../../../src/archive/tar', () => ({
  createArchive: mockCreateArchive,
  extractArchive: mockExtractArchive,
  getArchiveSize: mockGetArchiveSize,
}));
jest.unstable_mockModule('../../../src/storage/operations', () => ({
  checkObjectExists: mockCheckObjectExists,
  findNewestObject: mockFindNewestObject,
  downloadFile: mockDownloadFile,
  uploadFile: mockUploadFile,
}));

const { buildS3Tier, findS3Match, restoreFromS3, saveToS3 } = await import(
  '../../../src/core/s3Tier'
);
type S3Tier = Awaited<ReturnType<typeof buildS3Tier>>;

const FEATURE = 'refs/heads/feature';
const MAIN = 'refs/heads/main';
const PATTERN = '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}';
const zstd: CompressionConfig = { method: 'zstd', archiveFilename: 'cache.tar.zst' };
const VERSION = computeCacheVersion(['~/.npm'], 'zstd', false);
const storage = {
  client: {} as S3Client,
  bucket: 'bucket',
  providerConfig: { provider: 'seaweedfs', region: 'us-east-1', forcePathStyle: true },
} as StorageContext;
const templateFor = (scopedToRef: boolean) =>
  compileKeyTemplate({
    pattern: PATTERN,
    repository: 'octo/app',
    prefix: '',
    scopedToRepository: true,
    scopedToRef,
    version: VERSION,
    archiveFilename: 'cache.tar.zst',
    env: {},
  });
const tier = (overrides: Partial<S3Tier> = {}): S3Tier => ({
  storage,
  template: templateFor(true),
  restoreRefs: [FEATURE, MAIN],
  saveRef: FEATURE,
  compression: zstd,
  workspace: '/ws',
  streamRetries: 0,
  ...overrides,
});

// A tiny in-memory bucket behind the mocked HEAD and paginated-list operations.
const objects = new Map<string, { size: number; lastModified: Date; etag: string }>();
const put = (ref: string, key: string, minute: number, version = VERSION): string => {
  const objectKey = `octo/app/${encodeURIComponent(ref)}/${key}/${version}/cache.tar.zst`;
  objects.set(objectKey, {
    size: 100 + minute,
    lastModified: new Date(Date.UTC(2026, 8, 13, 10, minute)),
    etag: `"${key}"`,
  });
  return objectKey;
};

beforeEach(() => {
  objects.clear();
  jest.clearAllMocks();
  mockCheckObjectExists.mockImplementation(async (_client, _bucket, key) => {
    const found = objects.get(key);
    return found ? { key, ...found } : null;
  });
  mockFindNewestObject.mockImplementation(async (_client, _bucket, prefix, accept) => {
    let newest: CacheObjectMetadata | undefined;
    for (const [key, found] of [...objects.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (
        key.startsWith(prefix) &&
        accept(key) &&
        (!newest || found.lastModified > (newest.lastModified as Date))
      ) {
        newest = { key, size: found.size, lastModified: found.lastModified, etag: found.etag };
      }
    }
    return newest;
  });
  mockDownloadFile.mockResolvedValue();
  mockExtractArchive.mockResolvedValue();
  mockCreateArchive.mockResolvedValue();
  mockGetArchiveSize.mockReturnValue(2048);
  mockUploadFile.mockResolvedValue({ size: 2048, etag: '"new"' });
  mockResolveCachePaths.mockResolvedValue({ entries: ['node_modules'], skipped: [] });
});

describe('findS3Match', () => {
  it('prefers the exact key on the current ref over newer prefix matches', async () => {
    const exact = put(FEATURE, 'k', 1);
    put(FEATURE, 'k-newer', 9);
    await expect(findS3Match(tier(), 'k', ['k-'])).resolves.toEqual({
      matchedKey: 'k',
      exact: true,
      objectKey: exact,
      size: 101,
      etag: '"k"',
      ref: FEATURE,
    });
  });

  it('tries the primary key as a prefix before any restore key', async () => {
    put(FEATURE, 'k-2', 1);
    put(FEATURE, 'npm-x', 9);
    await expect(findS3Match(tier(), 'k', ['npm-'])).resolves.toMatchObject({
      matchedKey: 'k-2',
      exact: false,
    });
  });

  it('tries restore keys in input order', async () => {
    put(FEATURE, 'b-1', 9);
    put(FEATURE, 'a-1', 1);
    await expect(findS3Match(tier(), 'k', ['a-', 'b-'])).resolves.toMatchObject({
      matchedKey: 'a-1',
    });
  });

  it('takes the newest object for a prefix', async () => {
    put(FEATURE, 'npm-1', 1);
    put(FEATURE, 'npm-2', 5);
    await expect(findS3Match(tier(), 'k', ['npm-'])).resolves.toMatchObject({
      matchedKey: 'npm-2',
    });
  });

  it('searches the whole current ref before the default branch', async () => {
    put(MAIN, 'k', 9);
    put(FEATURE, 'npm-old', 1);
    await expect(findS3Match(tier(), 'k', ['npm-'])).resolves.toMatchObject({
      matchedKey: 'npm-old',
      ref: FEATURE,
    });
  });

  it("falls back to the default branch's cache", async () => {
    put(MAIN, 'k', 1);
    await expect(findS3Match(tier(), 'k', [])).resolves.toMatchObject({
      matchedKey: 'k',
      exact: true,
      ref: MAIN,
    });
  });

  it("never lets the default branch restore a feature branch's cache", async () => {
    put(FEATURE, 'k', 1);
    await expect(
      findS3Match(tier({ restoreRefs: [MAIN], saveRef: MAIN }), 'k', ['k'])
    ).resolves.toBeUndefined();
  });

  it('ignores objects saved with another version', async () => {
    put(FEATURE, 'k', 1, 'ffffffffffffffff');
    await expect(findS3Match(tier(), 'k', ['k'])).resolves.toBeUndefined();
  });

  it('matches keys that contain slashes by prefix', async () => {
    put(FEATURE, 'Linux/node-20/abc', 1);
    await expect(
      findS3Match(tier(), 'Linux/node-20/xyz', ['Linux/node-20/'])
    ).resolves.toMatchObject({
      matchedKey: 'Linux/node-20/abc',
    });
  });

  it('ignores refs when caches are not scoped to a ref', async () => {
    objects.set(`octo/app/k/${VERSION}/cache.tar.zst`, {
      size: 7,
      lastModified: new Date(),
      etag: '"unscoped"',
    });
    const unscoped = tier({ template: templateFor(false), restoreRefs: [''], saveRef: '' });
    await expect(findS3Match(unscoped, 'k', [])).resolves.toMatchObject({
      matchedKey: 'k',
      exact: true,
      ref: '',
    });
  });
});

describe('restoreFromS3', () => {
  it('reports a lookup-only hit without downloading', async () => {
    const objectKey = put(FEATURE, 'k', 1);
    await expect(restoreFromS3(tier(), 'k', [], true)).resolves.toEqual({
      kind: 'hit',
      matchedKey: 'k',
      exact: true,
      s3: { objectKey, size: 101, etag: '"k"' },
    });
    expect(mockDownloadFile).not.toHaveBeenCalled();
  });

  it('downloads to a temporary directory, extracts into the workspace and cleans up', async () => {
    const objectKey = put(FEATURE, 'k', 1);
    await expect(restoreFromS3(tier(), 'k', [], false)).resolves.toMatchObject({
      kind: 'hit',
      matchedKey: 'k',
    });
    const [, bucket, key, target] = mockDownloadFile.mock.calls[0];
    expect([bucket, key, path.basename(target)]).toEqual(['bucket', objectKey, 'cache.tar.zst']);
    expect(mockExtractArchive).toHaveBeenCalledWith(target, zstd, '/ws');
    expect(fs.existsSync(path.dirname(target))).toBe(false);
  });

  it('returns a download failure as an error without extracting', async () => {
    put(FEATURE, 'k', 1);
    mockDownloadFile.mockRejectedValue(new Error('connection reset by peer'));
    const outcome = await restoreFromS3(tier(), 'k', [], false);
    expect(outcome.kind === 'error' && outcome.error.message).toBe('connection reset by peer');
    expect(mockExtractArchive).not.toHaveBeenCalled();
    expect(fs.existsSync(path.dirname(mockDownloadFile.mock.calls[0][3]))).toBe(false);
  });

  it('does not repeat a download the SDK already retried', async () => {
    put(FEATURE, 'k', 1);
    mockDownloadFile.mockRejectedValue(
      Object.assign(new Error('Service Unavailable'), {
        $metadata: { httpStatusCode: 503, attempts: 4 },
      })
    );
    const outcome = await restoreFromS3(tier({ streamRetries: 3 }), 'k', [], false);
    expect(outcome.kind === 'error' && outcome.error.message).toBe('Service Unavailable');
    expect(mockDownloadFile).toHaveBeenCalledTimes(1);
  });

  it('returns a listing failure as an error', async () => {
    mockFindNewestObject.mockRejectedValue(
      Object.assign(new Error('Access Denied'), { name: 'AccessDenied' })
    );
    await expect(restoreFromS3(tier(), 'k', ['k-'], false)).resolves.toMatchObject({
      kind: 'error',
    });
  });

  it('reports a miss', async () => {
    await expect(restoreFromS3(tier(), 'k', ['k-'], false)).resolves.toEqual({ kind: 'miss' });
  });
});

describe('saveToS3', () => {
  it('does not archive when the object already exists', async () => {
    const objectKey = put(FEATURE, 'k', 1);
    await expect(saveToS3(tier(), 'k', ['node_modules'])).resolves.toEqual({
      kind: 'exists',
      s3: { objectKey, size: 101, etag: '"k"' },
    });
    expect(mockCreateArchive).not.toHaveBeenCalled();
  });

  it('skips with a path validation warning when nothing matches', async () => {
    mockResolveCachePaths.mockResolvedValue({ entries: [], skipped: [] });
    await expect(saveToS3(tier(), 'k', ['missing'])).resolves.toEqual({
      kind: 'skipped',
      reason: 'no paths matched',
    });
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('Path Validation Error'));
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('archives the resolved entries and uploads them under the current ref', async () => {
    const outcome = await saveToS3(
      tier(),
      'k',
      ['node_modules', '!node_modules/.cache'],
      5_242_880
    );
    const objectKey = `octo/app/refs%2Fheads%2Ffeature/k/${VERSION}/cache.tar.zst`;
    expect(outcome).toEqual({ kind: 'saved', s3: { objectKey, size: 2048, etag: '"new"' } });
    expect(mockResolveCachePaths).toHaveBeenCalledWith(
      ['node_modules', '!node_modules/.cache'],
      '/ws'
    );
    const [archivePath, entries, compression, workspace] = mockCreateArchive.mock.calls[0];
    expect([path.basename(archivePath), entries, compression, workspace]).toEqual([
      'cache.tar.zst',
      ['node_modules'],
      zstd,
      '/ws',
    ]);
    expect(mockUploadFile).toHaveBeenCalledWith(
      storage.client,
      'bucket',
      objectKey,
      archivePath,
      5_242_880
    );
    expect(fs.existsSync(path.dirname(archivePath))).toBe(false);
  });

  it('does not repeat an upload the SDK already retried', async () => {
    mockUploadFile.mockRejectedValue(
      Object.assign(new Error('Service Unavailable'), {
        $metadata: { httpStatusCode: 503, attempts: 4 },
      })
    );
    await expect(
      saveToS3(tier({ streamRetries: 3 }), 'k', ['node_modules'])
    ).resolves.toMatchObject({ kind: 'error' });
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
  });

  it('returns an upload failure as an error', async () => {
    mockUploadFile.mockRejectedValue(
      Object.assign(new Error('Access Denied'), { name: 'AccessDenied' })
    );
    await expect(saveToS3(tier(), 'k', ['node_modules'])).resolves.toMatchObject({ kind: 'error' });
  });
});

describe('buildS3Tier', () => {
  const config: CacheConfig = {
    primaryKey: 'k',
    paths: ['~/.npm'],
    restoreKeys: [],
    lookupOnly: false,
    failOnCacheMiss: false,
    readOnly: false,
    enableCrossOsArchive: false,
    uploadChunkSize: undefined,
    s3KeyPattern: PATTERN,
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
  };
  let eventDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    eventDir = makeTempDir('event');
    fs.writeFileSync(
      path.join(eventDir, 'event.json'),
      JSON.stringify({ repository: { default_branch: 'main' } })
    );
    env = {
      GITHUB_REF: FEATURE,
      GITHUB_EVENT_PATH: path.join(eventDir, 'event.json'),
      GITHUB_REPOSITORY: 'octo/app',
      GITHUB_WORKSPACE: '/ws',
    };
    mockCreateStorageContext.mockReturnValue(storage);
    mockGetCompressionConfig.mockResolvedValue(zstd);
  });

  afterEach(() => removeDir(eventDir));

  it('scopes to the current ref and searches the default branch', async () => {
    const built = await buildS3Tier(config, env);
    expect(mockCreateStorageContext).toHaveBeenCalledWith({ maxAttempts: 4 });
    expect(built).toMatchObject({
      restoreRefs: [FEATURE, MAIN],
      saveRef: FEATURE,
      workspace: '/ws',
      streamRetries: 3,
    });
    expect(built.template.objectKey(FEATURE, 'k')).toBe(
      `octo/app/refs%2Fheads%2Ffeature/k/${VERSION}/cache.tar.zst`
    );
  });

  it('does not scope by ref without GITHUB_REF or with scoped-to-ref: false', async () => {
    for (const built of [
      await buildS3Tier(config, { ...env, GITHUB_REF: undefined }),
      await buildS3Tier({ ...config, scopedToRef: false }, env),
    ]) {
      expect(built).toMatchObject({ restoreRefs: [''], saveRef: '' });
      expect(built.template.objectKey('', 'k')).toBe(`octo/app/k/${VERSION}/cache.tar.zst`);
    }
  });

  it('makes a single attempt when retries are disabled', async () => {
    const built = await buildS3Tier({ ...config, retryEnabled: false }, env);
    expect(mockCreateStorageContext).toHaveBeenCalledWith({ maxAttempts: 1 });
    expect(built.streamRetries).toBe(0);
  });

  it('surfaces pattern warnings', async () => {
    await buildS3Tier({ ...config, s3KeyPattern: '${key}/${archive_filename}' }, env);
    expect(mockWarning).toHaveBeenCalledTimes(2);
  });

  it('rejects a pattern without ${key}', async () => {
    await expect(
      buildS3Tier({ ...config, s3KeyPattern: '${archive_filename}' }, env)
    ).rejects.toThrow('exactly once');
  });
});
