import * as core from '@actions/core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  getCompressionConfig,
  type CompressionConfig,
  type CompressionMethod,
} from '../archive/compression';
import { createSha256Tap, sha256File } from '../archive/checksum';
import { getWorkspace, resolveCachePaths } from '../archive/paths';
import {
  buildCreateCommands,
  buildExtractCommands,
  createArchive,
  extractArchive,
  findTar,
  formatManifest,
  getArchiveSize,
  usesSeparateZstd,
  type TarTool,
} from '../archive/tar';
import {
  captureStderrTail,
  createByteCounter,
  killIfRunning,
  spawnArchiveCommand,
  waitForExit,
} from '../archive/stream';
import { Defaults } from '../constants';
import { createStorageContext, type StorageContext } from '../storage/client';
import {
  checkObjectExists,
  createStreamUpload,
  downloadFile,
  findNewestObject,
  getObjectStream,
  uploadFile,
} from '../storage/operations';
import { isRetryableStreamError, withRetry } from '../storage/retry';
import { formatSize, isExactKeyMatch } from '../utils/inputUtils';
import type { CacheConfig } from './config';
import { compileKeyTemplate, type KeyTemplate } from './keyTemplate';
import { toError, type RestoreOutcome, type SaveOutcome } from './outcomes';
import { resolveRefCandidates } from './refs';
import { computeCacheVersion } from './version';

/** Logged when streaming is requested but the plan needs the BSD-tar-plus-zstd two-step on Windows. */
const STREAMING_FALLBACK_MESSAGE =
  'Streaming is not supported with BSD tar and zstd on Windows; using a temporary archive file.';

export interface S3Tier {
  storage: StorageContext;
  template: KeyTemplate;
  /** Refs a restore searches, in order; [''] when caches are not scoped to a ref. */
  restoreRefs: readonly string[];
  /** Ref saves are written under; '' when caches are not scoped to a ref. */
  saveRef: string;
  compression: CompressionConfig;
  workspace: string;
  /** Extra attempts for download and upload streams, which the SDK does not retry itself. */
  streamRetries: number;
  /** Stream archives directly between tar and S3 instead of using a temporary file (Task 8). */
  streaming: boolean;
}

export interface S3Match {
  matchedKey: string;
  exact: boolean;
  objectKey: string;
  size: number;
  etag?: string;
  ref: string;
}

export interface BuildS3TierOptions {
  /** Compression method the restore step used; detected again when absent or unknown. */
  compression?: string;
}

/** Object metadata key holding the archive's sha256, verified before extracting on restore. */
const SHA256_METADATA_KEY = 'cloud-cache-sha256';

/** True when a failed conditional upload means another job already won the write. */
function isPreconditionFailed(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const error = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return error.$metadata?.httpStatusCode === 412 || error.name === 'PreconditionFailed';
}

const CONDITION_REJECTED_NAMES = new Set(['NotImplemented', 'NotSupported', 'InvalidArgument']);

/** True when the server rejected the `If-None-Match` header itself, rather than the condition. */
function isConditionUnsupported(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const error = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  if (error.$metadata?.httpStatusCode === 501) {
    return true;
  }
  return (
    error.name !== undefined &&
    CONDITION_REJECTED_NAMES.has(error.name) &&
    /if-none-match/i.test(error.message ?? '')
  );
}

const COMPRESSION_CONFIGS: Record<CompressionMethod, CompressionConfig> = {
  zstd: { method: 'zstd', archiveFilename: Defaults.DefaultArchiveFilenameZstd },
  gzip: { method: 'gzip', archiveFilename: Defaults.DefaultArchiveFilenameGzip },
};

async function resolveCompression(persisted: string | undefined): Promise<CompressionConfig> {
  if (persisted === 'zstd' || persisted === 'gzip') {
    core.debug(`Using the ${persisted} compression the restore step used.`);
    return COMPRESSION_CONFIGS[persisted];
  }
  return getCompressionConfig();
}

export async function buildS3Tier(
  config: CacheConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: BuildS3TierOptions = {}
): Promise<S3Tier> {
  const storage = createStorageContext({
    maxAttempts: config.retryEnabled ? config.retryCount + 1 : 1,
  });
  const compression = await resolveCompression(options.compression);
  const refs = resolveRefCandidates(env);
  const scopedToRef = config.scopedToRef && refs.current !== undefined;
  if (config.scopedToRef && !scopedToRef) {
    core.debug('GITHUB_REF is not set, so caches are not scoped to a ref.');
  }

  const template = compileKeyTemplate({
    pattern: config.s3KeyPattern,
    repository: env.GITHUB_REPOSITORY ?? '',
    prefix: config.prefix,
    scopedToRepository: config.scopedToRepository,
    scopedToRef,
    version: computeCacheVersion(config.paths, compression.method, config.enableCrossOsArchive),
    archiveFilename: compression.archiveFilename,
    env,
  });
  for (const warning of template.warnings) {
    core.warning(warning);
  }
  // A pattern without ${ref} gives every ref the same object keys; search them only once.
  const usesRef = scopedToRef && template.objectKey('a', '') !== template.objectKey('b', '');

  return {
    storage,
    template,
    restoreRefs: usesRef ? refs.restore : [''],
    saveRef: usesRef ? (refs.current as string) : '',
    compression,
    workspace: getWorkspace(env),
    streamRetries: config.retryEnabled ? config.retryCount : 0,
    streaming: config.streaming,
  };
}

/**
 * For each ref in order: the exact key, then the primary key as a prefix, then each restore
 * key as a prefix, taking the newest object for a prefix. Only objects the template accepts
 * (same version and archive format) count. The first hit wins.
 */
export async function findS3Match(
  tier: S3Tier,
  primaryKey: string,
  restoreKeys: readonly string[]
): Promise<S3Match | undefined> {
  const { client, bucket } = tier.storage;
  for (const ref of tier.restoreRefs) {
    const exactKey = tier.template.objectKey(ref, primaryKey);
    core.debug(`Checking s3://${bucket}/${exactKey}`);
    const exact = await checkObjectExists(client, bucket, exactKey);
    if (exact) {
      return {
        matchedKey: primaryKey,
        exact: true,
        objectKey: exactKey,
        size: exact.size,
        etag: exact.etag,
        ref,
      };
    }

    for (const keyPrefix of [primaryKey, ...restoreKeys]) {
      const searchPrefix = tier.template.searchPrefix(ref, keyPrefix);
      core.debug(`Listing s3://${bucket}/${searchPrefix}`);
      const newest = await findNewestObject(
        client,
        bucket,
        searchPrefix,
        (objectKey) => tier.template.extractKey(ref, objectKey) !== undefined
      );
      if (newest) {
        const matchedKey = tier.template.extractKey(ref, newest.key) as string;
        return {
          matchedKey,
          exact: isExactKeyMatch(primaryKey, matchedKey),
          objectKey: newest.key,
          size: newest.size,
          etag: newest.etag,
          ref,
        };
      }
    }
  }
  return undefined;
}

export async function restoreFromS3(
  tier: S3Tier,
  primaryKey: string,
  restoreKeys: readonly string[],
  lookupOnly: boolean
): Promise<RestoreOutcome> {
  let match: S3Match | undefined;
  try {
    match = await findS3Match(tier, primaryKey, restoreKeys);
  } catch (err) {
    return { kind: 'error', error: toError(err) };
  }
  if (!match) {
    return { kind: 'miss' };
  }

  const found = match;
  const hit: RestoreOutcome = {
    kind: 'hit',
    matchedKey: found.matchedKey,
    exact: found.exact,
    s3: { objectKey: found.objectKey, size: found.size, etag: found.etag },
  };
  if (lookupOnly) {
    return hit;
  }
  const where = found.ref ? ` on ${found.ref}` : '';
  core.info(
    `S3 cache ${found.exact ? 'hit' : 'partial hit'} for key "${found.matchedKey}"${where} (${formatSize(found.size)})`
  );

  if (tier.streaming) {
    const tar = await findTar();
    if (
      !usesSeparateZstd({ tar, platform: process.platform, compression: tier.compression.method })
    ) {
      return restoreFromS3Streaming(tier, found, tar, hit);
    }
    core.info(STREAMING_FALLBACK_MESSAGE);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-restore-'));
  try {
    const archivePath = path.join(tempDir, tier.compression.archiveFilename);
    const { client, bucket } = tier.storage;
    const { metadata } = await withRetry(
      () => downloadFile(client, bucket, found.objectKey, archivePath),
      {
        retries: tier.streamRetries,
        operationName: `Download of ${found.objectKey}`,
        shouldRetry: isRetryableStreamError,
      }
    );
    const expectedSha256 = metadata?.[SHA256_METADATA_KEY];
    if (expectedSha256) {
      const actualSha256 = await sha256File(archivePath);
      if (actualSha256 !== expectedSha256) {
        return {
          kind: 'error',
          error: new Error(
            `Integrity check failed for s3://${bucket}/${found.objectKey}: expected sha256 ${expectedSha256}, got ${actualSha256}`
          ),
        };
      }
    } else {
      core.debug(
        `s3://${bucket}/${found.objectKey} has no ${SHA256_METADATA_KEY} metadata; skipping integrity check.`
      );
    }
    await extractArchive(archivePath, tier.compression, tier.workspace);
    return hit;
  } catch (err) {
    return { kind: 'error', error: toError(err) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function saveToS3(
  tier: S3Tier,
  primaryKey: string,
  patterns: readonly string[],
  uploadChunkSize?: number
): Promise<SaveOutcome> {
  const { client, bucket } = tier.storage;
  const objectKey = tier.template.objectKey(tier.saveRef, primaryKey);
  let tempDir: string | undefined;
  try {
    const existing = await checkObjectExists(client, bucket, objectKey);
    if (existing) {
      core.info(`Cache already exists at s3://${bucket}/${objectKey}; not uploading it again.`);
      return { kind: 'exists', s3: { objectKey, size: existing.size, etag: existing.etag } };
    }

    const { entries } = await resolveCachePaths(patterns, tier.workspace);
    if (entries.length === 0) {
      core.warning(
        'Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.'
      );
      return { kind: 'skipped', reason: 'no paths matched' };
    }

    if (tier.streaming) {
      const tar = await findTar();
      if (
        !usesSeparateZstd({ tar, platform: process.platform, compression: tier.compression.method })
      ) {
        return await saveToS3Streaming(tier, objectKey, entries, tar, primaryKey, uploadChunkSize);
      }
      core.info(STREAMING_FALLBACK_MESSAGE);
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-save-'));
    const archivePath = path.join(tempDir, tier.compression.archiveFilename);
    await createArchive(archivePath, entries, tier.compression, tier.workspace);
    const archiveSize = getArchiveSize(archivePath);
    core.info(`Uploading ${formatSize(archiveSize)} to s3://${bucket}/${objectKey}...`);
    const checksum = await sha256File(archivePath);
    const metadata = { [SHA256_METADATA_KEY]: checksum };
    const attemptUpload = (ifNoneMatch: string | undefined) =>
      withRetry(
        () =>
          uploadFile(client, bucket, objectKey, archivePath, uploadChunkSize, {
            metadata,
            ifNoneMatch,
          }),
        {
          retries: tier.streamRetries,
          operationName: `Upload of ${objectKey}`,
          shouldRetry: isRetryableStreamError,
        }
      );

    const sendCondition = !tier.storage.conditionalWriteUnsupported;
    try {
      const uploaded = await attemptUpload(sendCondition ? '*' : undefined);
      core.info(`Cache saved to S3 with key: ${primaryKey}`);
      return { kind: 'saved', s3: { objectKey, size: uploaded.size, etag: uploaded.etag } };
    } catch (err) {
      if (sendCondition && isPreconditionFailed(err)) {
        core.info(`Another job saved s3://${bucket}/${objectKey} first; keeping its cache.`);
        return { kind: 'exists', s3: { objectKey, size: archiveSize, etag: undefined } };
      }
      if (sendCondition && isConditionUnsupported(err)) {
        core.debug(
          `s3://${bucket} rejected the If-None-Match condition; retrying the upload of ${objectKey} without it.`
        );
        tier.storage.conditionalWriteUnsupported = true;
        const uploaded = await attemptUpload(undefined);
        core.info(`Cache saved to S3 with key: ${primaryKey}`);
        return { kind: 'saved', s3: { objectKey, size: uploaded.size, etag: uploaded.etag } };
      }
      throw err;
    }
  } catch (err) {
    return { kind: 'error', error: toError(err) };
  } finally {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

/** Wraps a failure with tar's recent stderr output, for a clearer error message. */
function withStderrTail(err: unknown, tail: readonly string[]): Error {
  const base = toError(err);
  if (tail.length === 0) {
    return base;
  }
  return new Error(`${base.message}\n${tail.join('\n')}`, { cause: base });
}

/**
 * Streaming save (Task 8): spawns tar writing the archive to stdout and pipes it, through a
 * byte counter (there is no file to stat for the size), into an S3 multipart upload. Tar and
 * the upload run concurrently; either one failing aborts the other, so a truncated or dropped
 * archive can never look like a successful upload.
 */
async function saveToS3Streaming(
  tier: S3Tier,
  objectKey: string,
  entries: readonly string[],
  tar: TarTool,
  primaryKey: string,
  uploadChunkSize?: number
): Promise<SaveOutcome> {
  const { client, bucket } = tier.storage;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-save-'));
  try {
    const manifestPath = path.join(tempDir, 'manifest.txt');
    fs.writeFileSync(manifestPath, formatManifest(entries));
    const [command] = buildCreateCommands({
      tar,
      platform: process.platform,
      compression: tier.compression.method,
      archivePath: '-',
      workspace: tier.workspace,
      tempDir,
      manifestPath,
    });

    const child = spawnArchiveCommand(command, ['ignore', 'pipe', 'pipe']);
    const stderrTail = captureStderrTail(child.stderr);
    const counter = createByteCounter();
    const pipePromise = pipeline(child.stdout as Readable, counter.stream);
    const tarDone = waitForExit(child).then((code) => {
      if (code !== 0) {
        throw new Error(`tar exited with code ${code}`);
      }
    });

    const sendCondition = !tier.storage.conditionalWriteUnsupported;
    core.info(`Streaming upload to s3://${bucket}/${objectKey}...`);
    const upload = createStreamUpload(client, bucket, objectKey, counter.stream, uploadChunkSize, {
      ifNoneMatch: sendCondition ? '*' : undefined,
    });

    try {
      const [uploaded] = await Promise.all([upload.done(), tarDone, pipePromise]);
      core.info(`Cache saved to S3 with key: ${primaryKey}`);
      return {
        kind: 'saved',
        s3: { objectKey, size: counter.count(), etag: (uploaded as { ETag?: string }).ETag },
      };
    } catch (err) {
      if (sendCondition && isPreconditionFailed(err)) {
        core.info(`Another job saved s3://${bucket}/${objectKey} first; keeping its cache.`);
        await upload.abort().catch(() => undefined);
        killIfRunning(child);
        return { kind: 'exists', s3: { objectKey, size: counter.count(), etag: undefined } };
      }
      await upload.abort().catch(() => undefined);
      killIfRunning(child);
      throw withStderrTail(err, stderrTail.lines());
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Streaming restore (Task 8): pipes the GetObject body through the sha256 tap into a spawned
 * tar extract reading from stdin, so nothing touches disk except the extracted files themselves.
 */
async function restoreFromS3Streaming(
  tier: S3Tier,
  found: S3Match,
  tar: TarTool,
  hit: RestoreOutcome
): Promise<RestoreOutcome> {
  const { client, bucket } = tier.storage;
  try {
    const { body, metadata } = await getObjectStream(client, bucket, found.objectKey);
    fs.mkdirSync(tier.workspace, { recursive: true });
    const [command] = buildExtractCommands({
      tar,
      platform: process.platform,
      compression: tier.compression.method,
      archivePath: '-',
      workspace: tier.workspace,
      tempDir: os.tmpdir(),
    });

    const child = spawnArchiveCommand(command, ['pipe', 'ignore', 'pipe']);
    const stderrTail = captureStderrTail(child.stderr);
    const tap = createSha256Tap();
    const pipePromise = pipeline(body, tap.stream, child.stdin as Writable);
    const tarDone = waitForExit(child).then((code) => {
      if (code !== 0) {
        throw new Error(`tar exited with code ${code}`);
      }
    });

    try {
      await Promise.all([pipePromise, tarDone]);
    } catch (err) {
      killIfRunning(child);
      throw withStderrTail(err, stderrTail.lines());
    }

    const expectedSha256 = metadata?.[SHA256_METADATA_KEY];
    if (expectedSha256) {
      const actualSha256 = tap.digest();
      if (actualSha256 !== expectedSha256) {
        return {
          kind: 'error',
          error: new Error(
            `Integrity check failed for s3://${bucket}/${found.objectKey}: expected sha256 ${expectedSha256}, got ${actualSha256}; files may already have been extracted`
          ),
        };
      }
    } else {
      core.debug(
        `s3://${bucket}/${found.objectKey} has no ${SHA256_METADATA_KEY} metadata; skipping integrity check.`
      );
    }
    return hit;
  } catch (err) {
    return { kind: 'error', error: toError(err) };
  }
}
