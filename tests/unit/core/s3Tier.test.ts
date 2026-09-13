import { jest } from '@jest/globals';
import type { S3Client } from '@aws-sdk/client-s3';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import type { CompressionConfig } from '../../../src/archive/compression';
import type { ResolvedCachePaths } from '../../../src/archive/paths';
import type { ArchiveCommand, ArchivePlan, TarTool } from '../../../src/archive/tar';
import type { CacheConfig } from '../../../src/core/config';
import { compileKeyTemplate } from '../../../src/core/keyTemplate';
import { computeCacheVersion } from '../../../src/core/version';
import type { StorageContext } from '../../../src/storage/client';
import type { CacheObjectMetadata, ObjectStreamResult } from '../../../src/storage/operations';
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
  jest.fn<
    (
      client: S3Client,
      bucket: string,
      key: string,
      destination: string
    ) => Promise<{ metadata?: Record<string, string> }>
  >();
const mockUploadFile =
  jest.fn<
    (
      client: S3Client,
      bucket: string,
      key: string,
      source: string,
      chunkSize?: number,
      options?: { metadata?: Record<string, string>; ifNoneMatch?: string }
    ) => Promise<{ size: number; etag?: string }>
  >();
const mockSha256File = jest.fn<(filePath: string) => Promise<string>>();

const mockInfo = jest.fn<(message: string) => void>();
const mockDebug = jest.fn<(message: string) => void>();

// Streaming (Task 8) mocks.
const mockFindTar = jest.fn<() => Promise<TarTool>>();
const mockUsesSeparateZstd =
  jest.fn<(plan: Pick<ArchivePlan, 'tar' | 'platform' | 'compression'>) => boolean>();
const mockBuildCreateCommands = jest.fn<(plan: Record<string, unknown>) => ArchiveCommand[]>();
const mockBuildExtractCommands = jest.fn<(plan: Record<string, unknown>) => ArchiveCommand[]>();
const mockFormatManifest = jest.fn<(entries: readonly string[]) => string>();

interface FakeChild {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: (signal?: string) => void;
  exitCode: number | null;
  signalCode: string | null;
}
const makeFakeChild = (): FakeChild => ({
  stdout: new PassThrough(),
  stderr: new PassThrough(),
  stdin: new PassThrough(),
  kill: jest.fn(),
  exitCode: null,
  signalCode: null,
});
const mockSpawnArchiveCommand = jest.fn<(command: ArchiveCommand, stdio: unknown) => FakeChild>();
const mockWaitForExit = jest.fn<(child: FakeChild) => Promise<number>>();
const mockKillIfRunning = jest.fn<(child: FakeChild) => void>();
const mockCaptureStderrTail =
  jest.fn<(stream: unknown, maxLines?: number) => { lines(): string[] }>();

const mockGetObjectStream =
  jest.fn<(client: S3Client, bucket: string, key: string) => Promise<ObjectStreamResult>>();
interface FakeUpload {
  done: () => Promise<{ ETag?: string }>;
  abort: () => Promise<unknown>;
}
const mockCreateStreamUpload =
  jest.fn<
    (
      client: S3Client,
      bucket: string,
      key: string,
      body: Readable,
      chunkSize?: number,
      options?: { ifNoneMatch?: string }
    ) => FakeUpload
  >();

jest.unstable_mockModule('@actions/core', () => ({
  debug: mockDebug,
  info: mockInfo,
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
  findTar: mockFindTar,
  usesSeparateZstd: mockUsesSeparateZstd,
  buildCreateCommands: mockBuildCreateCommands,
  buildExtractCommands: mockBuildExtractCommands,
  formatManifest: mockFormatManifest,
}));
jest.unstable_mockModule('../../../src/archive/stream', () => ({
  spawnArchiveCommand: mockSpawnArchiveCommand,
  waitForExit: mockWaitForExit,
  killIfRunning: mockKillIfRunning,
  captureStderrTail: mockCaptureStderrTail,
  createByteCounter: () => {
    let total = 0;
    const stream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        total += chunk.length;
        callback(null, chunk);
      },
    });
    return { stream, count: () => total };
  },
}));
jest.unstable_mockModule('../../../src/storage/operations', () => ({
  checkObjectExists: mockCheckObjectExists,
  findNewestObject: mockFindNewestObject,
  downloadFile: mockDownloadFile,
  uploadFile: mockUploadFile,
  getObjectStream: mockGetObjectStream,
  createStreamUpload: mockCreateStreamUpload,
}));
jest.unstable_mockModule('../../../src/archive/checksum', () => ({
  sha256File: mockSha256File,
  createSha256Tap: () => {
    const hash = crypto.createHash('sha256');
    const stream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    return { stream, digest: () => hash.digest('hex') };
  },
}));

const { buildS3Tier, findS3Match, restoreFromS3, saveToS3 } = await import(
  '../../../src/core/s3Tier'
);
type S3Tier = Awaited<ReturnType<typeof buildS3Tier>>;

const FEATURE = 'refs/heads/feature';
const MAIN = 'refs/heads/main';
const PATTERN = '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}';
const zstd: CompressionConfig = { method: 'zstd', archiveFilename: 'cache.tar.zst' };
const gzip: CompressionConfig = { method: 'gzip', archiveFilename: 'cache.tar.gz' };
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
  streaming: false,
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
  delete storage.conditionalWriteUnsupported;
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
  mockDownloadFile.mockResolvedValue({});
  mockExtractArchive.mockResolvedValue();
  mockCreateArchive.mockResolvedValue();
  mockGetArchiveSize.mockReturnValue(2048);
  mockUploadFile.mockResolvedValue({ size: 2048, etag: '"new"' });
  mockResolveCachePaths.mockResolvedValue({ entries: ['node_modules'], skipped: [] });
  mockSha256File.mockResolvedValue('archive-sha256');

  // Streaming (Task 8) defaults: GNU tar on Linux, a single-command plan, no fallback.
  mockFindTar.mockResolvedValue({ path: '/usr/bin/tar', flavor: 'gnu' });
  mockUsesSeparateZstd.mockReturnValue(false);
  mockBuildCreateCommands.mockImplementation((plan) => [
    { tool: (plan.tar as TarTool).path, args: ['-cf', plan.archivePath as string] },
  ]);
  mockBuildExtractCommands.mockImplementation((plan) => [
    { tool: (plan.tar as TarTool).path, args: ['-xf', plan.archivePath as string] },
  ]);
  mockFormatManifest.mockImplementation((entries) => `${entries.join('\n')}\n`);
  mockCaptureStderrTail.mockReturnValue({ lines: () => [] });
  mockKillIfRunning.mockImplementation(() => undefined);
  mockCreateStreamUpload.mockImplementation(() => ({
    done: jest.fn(async () => ({ ETag: '"streamed"' })),
    abort: jest.fn(async () => undefined),
  }));
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

  it('does not log its own info line on a lookup-only hit, since restoreImpl already reports it', async () => {
    put(FEATURE, 'k', 1);
    await restoreFromS3(tier(), 'k', [], true);
    expect(mockInfo).not.toHaveBeenCalled();
  });

  it('logs an info line on a real restore', async () => {
    put(FEATURE, 'k', 1);
    await restoreFromS3(tier(), 'k', [], false);
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('S3 cache hit'));
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

  describe('integrity check', () => {
    it('extracts when the downloaded archive matches the sha256 in the object metadata', async () => {
      put(FEATURE, 'k', 1);
      mockDownloadFile.mockResolvedValue({ metadata: { 'cloud-cache-sha256': 'good-hash' } });
      mockSha256File.mockResolvedValue('good-hash');
      const outcome = await restoreFromS3(tier(), 'k', [], false);
      expect(outcome.kind).toBe('hit');
      expect(mockExtractArchive).toHaveBeenCalled();
    });

    it('returns an integrity error without extracting on a sha256 mismatch', async () => {
      const objectKey = put(FEATURE, 'k', 1);
      mockDownloadFile.mockResolvedValue({ metadata: { 'cloud-cache-sha256': 'expected-hash' } });
      mockSha256File.mockResolvedValue('actual-hash');
      const outcome = await restoreFromS3(tier(), 'k', [], false);
      expect(outcome).toEqual({
        kind: 'error',
        error: new Error(
          `Integrity check failed for s3://bucket/${objectKey}: expected sha256 expected-hash, got actual-hash`
        ),
      });
      expect(mockExtractArchive).not.toHaveBeenCalled();
    });

    it('skips verification and logs a debug line when the object carries no checksum metadata', async () => {
      put(FEATURE, 'k', 1);
      mockDownloadFile.mockResolvedValue({});
      const outcome = await restoreFromS3(tier(), 'k', [], false);
      expect(outcome.kind).toBe('hit');
      expect(mockSha256File).not.toHaveBeenCalled();
      expect(mockExtractArchive).toHaveBeenCalled();
      expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining('sha256'));
    });
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
      5_242_880,
      { metadata: { 'cloud-cache-sha256': 'archive-sha256' }, ifNoneMatch: '*' }
    );
    expect(fs.existsSync(path.dirname(archivePath))).toBe(false);
  });

  it('hashes the archive and uploads its sha256 as object metadata', async () => {
    mockSha256File.mockResolvedValue(
      'c0ffee0000000000000000000000000000000000000000000000000000ffee'
    );
    await saveToS3(tier(), 'k', ['node_modules']);
    const [archivePath] = mockCreateArchive.mock.calls[0];
    expect(mockSha256File).toHaveBeenCalledWith(archivePath);
    const [, , , , , options] = mockUploadFile.mock.calls[0];
    expect(options).toEqual({
      metadata: {
        'cloud-cache-sha256': 'c0ffee0000000000000000000000000000000000000000000000000000ffee',
      },
      ifNoneMatch: '*',
    });
  });

  it('sends the If-None-Match condition on the first upload of a tier', async () => {
    await saveToS3(tier(), 'k', ['node_modules']);
    const [, , , , , options] = mockUploadFile.mock.calls[0];
    expect(options).toMatchObject({ ifNoneMatch: '*' });
  });

  it('returns exists and logs when the server reports a 412 precondition failure', async () => {
    mockUploadFile.mockRejectedValue(
      Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), {
        name: 'PreconditionFailed',
        $metadata: { httpStatusCode: 412 },
      })
    );
    const outcome = await saveToS3(tier(), 'k', ['node_modules']);
    const objectKey = `octo/app/refs%2Fheads%2Ffeature/k/${VERSION}/cache.tar.zst`;
    expect(outcome).toEqual({
      kind: 'exists',
      s3: { objectKey, size: 2048, etag: undefined },
    });
    expect(mockInfo).toHaveBeenCalledWith(
      `Another job saved s3://bucket/${objectKey} first; keeping its cache.`
    );
  });

  it('recognizes a precondition failure identified only by name, without a 412 status', async () => {
    mockUploadFile.mockRejectedValue(
      Object.assign(new Error('Precondition Failed'), {
        name: 'PreconditionFailed',
      })
    );
    const outcome = await saveToS3(tier(), 'k', ['node_modules']);
    expect(outcome.kind).toBe('exists');
  });

  it('retries once without the condition when the server rejects If-None-Match with a 501', async () => {
    mockUploadFile
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Implemented'), {
          name: 'NotImplemented',
          $metadata: { httpStatusCode: 501 },
        })
      )
      .mockResolvedValueOnce({ size: 2048, etag: '"fallback"' });
    const outcome = await saveToS3(tier(), 'k', ['node_modules']);
    const objectKey = `octo/app/refs%2Fheads%2Ffeature/k/${VERSION}/cache.tar.zst`;
    expect(outcome).toEqual({ kind: 'saved', s3: { objectKey, size: 2048, etag: '"fallback"' } });
    expect(mockUploadFile).toHaveBeenCalledTimes(2);
    const [, , , , , firstOptions] = mockUploadFile.mock.calls[0];
    const [, , , , , secondOptions] = mockUploadFile.mock.calls[1];
    expect(firstOptions).toMatchObject({ ifNoneMatch: '*' });
    expect(secondOptions).toEqual({ metadata: { 'cloud-cache-sha256': 'archive-sha256' } });
    expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining('If-None-Match'));
  });

  it('retries once without the condition when the server rejects it as InvalidArgument mentioning If-None-Match', async () => {
    mockUploadFile
      .mockRejectedValueOnce(
        Object.assign(new Error('Header "If-None-Match" is not supported for this operation'), {
          name: 'InvalidArgument',
        })
      )
      .mockResolvedValueOnce({ size: 2048, etag: '"fallback"' });
    const outcome = await saveToS3(tier(), 'k', ['node_modules']);
    expect(outcome.kind).toBe('saved');
  });

  it('does not treat an unrelated InvalidArgument as an unsupported condition', async () => {
    mockUploadFile.mockRejectedValue(
      Object.assign(new Error('Some other invalid argument'), { name: 'InvalidArgument' })
    );
    const outcome = await saveToS3(tier(), 'k', ['node_modules']);
    expect(outcome.kind).toBe('error');
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
  });

  it('remembers a server that rejects the condition, so a later save in the same tier skips it', async () => {
    mockUploadFile
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Implemented'), {
          name: 'NotImplemented',
          $metadata: { httpStatusCode: 501 },
        })
      )
      .mockResolvedValueOnce({ size: 2048, etag: '"first"' })
      .mockResolvedValueOnce({ size: 2048, etag: '"second"' });

    const first = await saveToS3(tier(), 'k', ['node_modules']);
    expect(first.kind).toBe('saved');
    expect(mockUploadFile).toHaveBeenCalledTimes(2);

    mockUploadFile.mockClear();
    const second = await saveToS3(tier(), 'k2', ['node_modules']);
    expect(second.kind).toBe('saved');
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    const [, , , , , options] = mockUploadFile.mock.calls[0];
    expect(options).toEqual({ metadata: { 'cloud-cache-sha256': 'archive-sha256' } });
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
    streaming: false,
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

  it('uses the compression method the restore step persisted instead of detecting it', async () => {
    for (const persisted of ['gzip', 'zstd'] as const) {
      mockGetCompressionConfig.mockResolvedValue(persisted === 'gzip' ? zstd : gzip);
      const built = await buildS3Tier(config, env, { compression: persisted });
      expect(built.compression).toEqual(persisted === 'gzip' ? gzip : zstd);
      const version = computeCacheVersion(['~/.npm'], persisted, false);
      expect(built.template.objectKey(FEATURE, 'k')).toBe(
        `octo/app/refs%2Fheads%2Ffeature/k/${version}/${built.compression.archiveFilename}`
      );
    }
    expect(mockGetCompressionConfig).not.toHaveBeenCalled();
  });

  it('detects compression when nothing usable was persisted', async () => {
    for (const persisted of [undefined, '', 'brotli']) {
      const built = await buildS3Tier(config, env, { compression: persisted });
      expect(built.compression).toEqual(zstd);
    }
    expect(mockGetCompressionConfig).toHaveBeenCalledTimes(3);
  });

  it('searches one ref when the pattern has no ${ref}, instead of repeating each lookup', async () => {
    const built = await buildS3Tier(
      { ...config, s3KeyPattern: '${GITHUB_REPOSITORY}/${key}/${version}/${archive_filename}' },
      env
    );
    expect(built).toMatchObject({ restoreRefs: [''], saveRef: '' });
    expect(built.template.objectKey('', 'k')).toBe(`octo/app/k/${VERSION}/cache.tar.zst`);

    objects.set(`octo/app/k-1/${VERSION}/cache.tar.zst`, {
      size: 7,
      lastModified: new Date(),
      etag: '"k-1"',
    });
    await expect(findS3Match(built, 'k', ['k-'])).resolves.toMatchObject({ matchedKey: 'k-1' });
    expect(mockCheckObjectExists).toHaveBeenCalledTimes(1);
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

  it.each([true, false])('carries the streaming config flag through (%s)', async (streaming) => {
    const built = await buildS3Tier({ ...config, streaming }, env);
    expect(built.streaming).toBe(streaming);
  });
});

describe('saveToS3 streaming', () => {
  it('streams the archive from tar straight into the upload, without a temporary file', async () => {
    let child: FakeChild | undefined;
    mockSpawnArchiveCommand.mockImplementation(() => {
      child = makeFakeChild();
      return child;
    });
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('streamed-archive-bytes'));
      return 0;
    });

    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules'], 5_242_880);

    const objectKey = `octo/app/refs%2Fheads%2Ffeature/k/${VERSION}/cache.tar.zst`;
    expect(outcome).toEqual({
      kind: 'saved',
      s3: { objectKey, size: 'streamed-archive-bytes'.length, etag: '"streamed"' },
    });
    expect(mockCreateArchive).not.toHaveBeenCalled();
    expect(mockGetArchiveSize).not.toHaveBeenCalled();
    expect(mockSha256File).not.toHaveBeenCalled();

    expect(mockFindTar).toHaveBeenCalled();
    const [command, stdio] = mockSpawnArchiveCommand.mock.calls[0];
    expect(command.tool).toBe('/usr/bin/tar');
    expect(stdio).toEqual(['ignore', 'pipe', 'pipe']);
    const [plan] = mockBuildCreateCommands.mock.calls[0];
    expect(plan).toMatchObject({ archivePath: '-', workspace: '/ws', compression: 'zstd' });

    const call = mockCreateStreamUpload.mock.calls[0];
    expect(call[1]).toBe('bucket');
    expect(call[2]).toBe(objectKey);
    expect(call[4]).toBe(5_242_880);
    expect(call[5]).toEqual({ ifNoneMatch: '*' });
  });

  it('does not spawn tar when the object already exists', async () => {
    const objectKey = put(FEATURE, 'k', 1);
    await expect(saveToS3(tier({ streaming: true }), 'k', ['node_modules'])).resolves.toEqual({
      kind: 'exists',
      s3: { objectKey, size: 101, etag: '"k"' },
    });
    expect(mockSpawnArchiveCommand).not.toHaveBeenCalled();
  });

  it('skips the If-None-Match condition once the tier has learned it is unsupported', async () => {
    storage.conditionalWriteUnsupported = true;
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('x'));
      return 0;
    });
    await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);
    const [, , , , , options] = mockCreateStreamUpload.mock.calls[0];
    expect(options).toEqual({ ifNoneMatch: undefined });
  });

  it('returns exists and logs when the server reports a 412 precondition failure', async () => {
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('archive-body'));
      return 0;
    });
    mockCreateStreamUpload.mockReturnValue({
      done: jest.fn(async () => {
        throw Object.assign(new Error('At least one of the pre-conditions did not hold'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        });
      }),
      abort: jest.fn(async () => undefined),
    });

    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);
    const objectKey = `octo/app/refs%2Fheads%2Ffeature/k/${VERSION}/cache.tar.zst`;
    expect(outcome).toEqual({
      kind: 'exists',
      s3: { objectKey, size: 'archive-body'.length, etag: undefined },
    });
    expect(mockInfo).toHaveBeenCalledWith(
      `Another job saved s3://bucket/${objectKey} first; keeping its cache.`
    );
  });

  it('aborts the upload and kills tar when tar exits non-zero', async () => {
    let child: FakeChild | undefined;
    mockSpawnArchiveCommand.mockImplementation(() => {
      child = makeFakeChild();
      return child;
    });
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end();
      return 2;
    });
    mockCaptureStderrTail.mockReturnValue({
      lines: () => ['tar: short write', 'tar: error exit delayed from previous errors'],
    });
    const abort = jest.fn(async () => undefined);
    mockCreateStreamUpload.mockReturnValue({
      done: jest.fn(() => new Promise<{ ETag?: string }>(() => undefined)),
      abort,
    });

    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);
    expect(outcome.kind).toBe('error');
    const message = outcome.kind === 'error' ? outcome.error.message : '';
    expect(message).toContain('tar exited with code 2');
    expect(message).toContain('tar: short write');
    expect(message).toContain('tar: error exit delayed from previous errors');
    expect(abort).toHaveBeenCalled();
    expect(mockKillIfRunning).toHaveBeenCalledWith(child);
  });

  it('aborts the upload and kills tar when the upload fails independently', async () => {
    let child: FakeChild | undefined;
    mockSpawnArchiveCommand.mockImplementation(() => {
      child = makeFakeChild();
      return child;
    });
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('ok'));
      return 0;
    });
    const abort = jest.fn(async () => undefined);
    mockCreateStreamUpload.mockReturnValue({
      done: jest.fn(async () => {
        throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
      }),
      abort,
    });

    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);
    expect(outcome.kind).toBe('error');
    const message = outcome.kind === 'error' ? outcome.error.message : '';
    expect(message).toContain('Access Denied');
    expect(abort).toHaveBeenCalled();
    expect(mockKillIfRunning).toHaveBeenCalledWith(child);
  });

  it('falls back to file mode when BSD tar and zstd on Windows would be needed', async () => {
    mockUsesSeparateZstd.mockReturnValue(true);
    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);
    expect(outcome.kind).toBe('saved');
    expect(mockCreateArchive).toHaveBeenCalled();
    expect(mockSpawnArchiveCommand).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(
      'Streaming is not supported with BSD tar and zstd on Windows; using a temporary archive file.'
    );
  });
});

describe('restoreFromS3 streaming', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTempDir('stream-restore-ws');
  });

  afterEach(() => removeDir(workspace));

  it('streams the download straight into a piped tar extract and verifies its sha256', async () => {
    put(FEATURE, 'k', 1);
    const payload = Buffer.from('archive-payload');
    const expectedSha256 = crypto.createHash('sha256').update(payload).digest('hex');
    mockGetObjectStream.mockResolvedValue({
      body: Readable.from([payload]),
      metadata: { 'cloud-cache-sha256': expectedSha256 },
    });
    let child: FakeChild | undefined;
    mockSpawnArchiveCommand.mockImplementation(() => {
      child = makeFakeChild();
      return child;
    });
    mockWaitForExit.mockResolvedValue(0);

    const outcome = await restoreFromS3(tier({ streaming: true, workspace }), 'k', [], false);

    expect(outcome).toMatchObject({ kind: 'hit', matchedKey: 'k' });
    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(mockExtractArchive).not.toHaveBeenCalled();
    expect(mockSha256File).not.toHaveBeenCalled();

    const [command, stdio] = mockSpawnArchiveCommand.mock.calls[0];
    expect(command.tool).toBe('/usr/bin/tar');
    expect(stdio).toEqual(['pipe', 'ignore', 'pipe']);
    const [plan] = mockBuildExtractCommands.mock.calls[0];
    expect(plan).toMatchObject({ archivePath: '-', workspace, compression: 'zstd' });
    expect(fs.existsSync(workspace)).toBe(true);
  });

  it('returns an integrity error, noting files may already be extracted, on a sha256 mismatch', async () => {
    const objectKey = put(FEATURE, 'k', 1);
    mockGetObjectStream.mockResolvedValue({
      body: Readable.from([Buffer.from('archive-payload')]),
      metadata: { 'cloud-cache-sha256': 'expected-hash' },
    });
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockResolvedValue(0);

    const outcome = await restoreFromS3(tier({ streaming: true, workspace }), 'k', [], false);
    expect(outcome.kind).toBe('error');
    const message = outcome.kind === 'error' ? outcome.error.message : '';
    expect(message).toContain(`Integrity check failed for s3://bucket/${objectKey}`);
    expect(message).toContain('expected sha256 expected-hash');
    expect(message).toContain('files may already have been extracted');
  });

  it('skips verification when the object carries no checksum metadata', async () => {
    put(FEATURE, 'k', 1);
    mockGetObjectStream.mockResolvedValue({ body: Readable.from([Buffer.from('data')]) });
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockResolvedValue(0);

    const outcome = await restoreFromS3(tier({ streaming: true, workspace }), 'k', [], false);
    expect(outcome.kind).toBe('hit');
    expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining('sha256'));
  });

  it('kills tar and returns an error, with its stderr tail, when tar fails', async () => {
    put(FEATURE, 'k', 1);
    mockGetObjectStream.mockResolvedValue({ body: Readable.from([Buffer.from('data')]) });
    let child: FakeChild | undefined;
    mockSpawnArchiveCommand.mockImplementation(() => {
      child = makeFakeChild();
      return child;
    });
    mockWaitForExit.mockResolvedValue(2);
    mockCaptureStderrTail.mockReturnValue({ lines: () => ['tar: corrupt input'] });

    const outcome = await restoreFromS3(tier({ streaming: true, workspace }), 'k', [], false);
    expect(outcome.kind).toBe('error');
    const message = outcome.kind === 'error' ? outcome.error.message : '';
    expect(message).toContain('tar exited with code 2');
    expect(message).toContain('tar: corrupt input');
    expect(mockKillIfRunning).toHaveBeenCalledWith(child);
  });

  it('falls back to file mode when BSD tar and zstd on Windows would be needed', async () => {
    put(FEATURE, 'k', 1);
    mockUsesSeparateZstd.mockReturnValue(true);

    const outcome = await restoreFromS3(tier({ streaming: true, workspace }), 'k', [], false);
    expect(outcome.kind).toBe('hit');
    expect(mockDownloadFile).toHaveBeenCalled();
    expect(mockSpawnArchiveCommand).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(
      'Streaming is not supported with BSD tar and zstd on Windows; using a temporary archive file.'
    );
  });
});
