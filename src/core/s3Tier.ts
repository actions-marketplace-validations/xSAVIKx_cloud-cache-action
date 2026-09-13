import * as core from '@actions/core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getCompressionConfig,
  type CompressionConfig,
  type CompressionMethod,
} from '../archive/compression';
import { getWorkspace, resolveCachePaths } from '../archive/paths';
import { createArchive, extractArchive, getArchiveSize } from '../archive/tar';
import { Defaults } from '../constants';
import { createStorageContext, type StorageContext } from '../storage/client';
import {
  checkObjectExists,
  downloadFile,
  findNewestObject,
  uploadFile,
} from '../storage/operations';
import { isRetryableStreamError, withRetry } from '../storage/retry';
import { formatSize, isExactKeyMatch } from '../utils/inputUtils';
import type { CacheConfig } from './config';
import { compileKeyTemplate, type KeyTemplate } from './keyTemplate';
import { toError, type RestoreOutcome, type SaveOutcome } from './outcomes';
import { resolveRefCandidates } from './refs';
import { computeCacheVersion } from './version';

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

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-restore-'));
  try {
    const archivePath = path.join(tempDir, tier.compression.archiveFilename);
    const { client, bucket } = tier.storage;
    await withRetry(() => downloadFile(client, bucket, found.objectKey, archivePath), {
      retries: tier.streamRetries,
      operationName: `Download of ${found.objectKey}`,
      shouldRetry: isRetryableStreamError,
    });
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

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-save-'));
    const archivePath = path.join(tempDir, tier.compression.archiveFilename);
    await createArchive(archivePath, entries, tier.compression, tier.workspace);
    core.info(
      `Uploading ${formatSize(getArchiveSize(archivePath))} to s3://${bucket}/${objectKey}...`
    );
    const uploaded = await withRetry(
      () => uploadFile(client, bucket, objectKey, archivePath, uploadChunkSize),
      {
        retries: tier.streamRetries,
        operationName: `Upload of ${objectKey}`,
        shouldRetry: isRetryableStreamError,
      }
    );
    core.info(`Cache saved to S3 with key: ${primaryKey}`);
    return { kind: 'saved', s3: { objectKey, size: uploaded.size, etag: uploaded.etag } };
  } catch (err) {
    return { kind: 'error', error: toError(err) };
  } finally {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
