import * as core from '@actions/core';
import type { ChildProcess } from 'node:child_process';
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
  waitForExitAfterKill,
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
import { encodeTagging, SHA256_METADATA_KEY, type ObjectTag } from './objectAttributes';
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
  streaming?: boolean;
  /** User metadata written on every save, next to the action's own sha256 entry. */
  metadata: Record<string, string>;
  /** Object tags written on every save, when the provider supports them. */
  tags: ObjectTag[];
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

/** True when a failed conditional upload means another job already won the write. */
function isPreconditionFailed(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const error = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return error.$metadata?.httpStatusCode === 412 || error.name === 'PreconditionFailed';
}

/**
 * True when a conditional upload hit a 409 ConditionalRequestConflict: a concurrent write or
 * delete of the same key (a parallel prune, for example) landed while it was in progress. Worth
 * one more attempt with the same condition.
 */
function isConditionalConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const error = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return error.$metadata?.httpStatusCode === 409 || error.name === 'ConditionalRequestConflict';
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

/** True when the server rejected the request because it does not implement object tagging. */
export function isTaggingUnsupported(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const error = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const message = (error.message ?? '').toLowerCase();
  return (
    error.name === 'NotImplemented' ||
    error.$metadata?.httpStatusCode === 501 ||
    message.includes('tagging') ||
    message.includes('x-amz-tagging')
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
    metadata: config.metadata,
    tags: config.tags,
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
    try {
      const tar = await findTar();
      if (
        !usesSeparateZstd({
          tar,
          platform: process.platform,
          compression: tier.compression.method,
        })
      ) {
        return await restoreFromS3Streaming(tier, found, tar, hit);
      }
      core.info(STREAMING_FALLBACK_MESSAGE);
    } catch (err) {
      return { kind: 'error', error: toError(err) };
    }
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

    return await saveToS3FileMode(tier, objectKey, entries, primaryKey, uploadChunkSize);
  } catch (err) {
    return { kind: 'error', error: toError(err) };
  }
}

/**
 * File-based save: archives to a temporary file, uploads it, and handles the Task 4 conditional
 * write outcomes (412 -> exists; a 409 conflict is retried once with the same condition; a
 * condition the server rejects outright is retried once without it). Used both as the default
 * (non-streaming) save path, and as the fallback a streaming save takes when its server rejects
 * `If-None-Match` outright or its conditional write conflicts (see `saveToS3Streaming`) — reused
 * rather than duplicated, so both paths agree on precondition handling. `retryConflict: false`
 * is passed by that 409 fallback, which already is the one retry.
 */
async function saveToS3FileMode(
  tier: S3Tier,
  objectKey: string,
  entries: readonly string[],
  primaryKey: string,
  uploadChunkSize?: number,
  retryConflict = true
): Promise<SaveOutcome> {
  const { client, bucket } = tier.storage;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-save-'));
  try {
    const archivePath = path.join(tempDir, tier.compression.archiveFilename);
    await createArchive(archivePath, entries, tier.compression, tier.workspace);
    const archiveSize = getArchiveSize(archivePath);
    core.info(`Uploading ${formatSize(archiveSize)} to s3://${bucket}/${objectKey}...`);
    const checksum = await sha256File(archivePath);
    const metadata = { ...tier.metadata, [SHA256_METADATA_KEY]: checksum };
    const attemptUpload = (ifNoneMatch: string | undefined, tagging: string | undefined) =>
      withRetry(
        () =>
          uploadFile(client, bucket, objectKey, archivePath, uploadChunkSize, {
            metadata,
            ifNoneMatch,
            tagging,
          }),
        {
          retries: tier.streamRetries,
          operationName: `Upload of ${objectKey}`,
          shouldRetry: isRetryableStreamError,
        }
      );

    const sendCondition = !tier.storage.conditionalWriteUnsupported;
    const attemptConditionalUpload = async (tagging: string | undefined) => {
      try {
        return await attemptUpload('*', tagging);
      } catch (err) {
        if (!retryConflict || !isConditionalConflict(err)) {
          throw err;
        }
        core.info(
          `A concurrent write to s3://${bucket}/${objectKey} conflicted with this upload; retrying it once.`
        );
        return await attemptUpload('*', tagging);
      }
    };
    const uploadWith = (tagging: string | undefined) =>
      sendCondition ? attemptConditionalUpload(tagging) : attemptUpload(undefined, tagging);
    // Omitted upfront once this context's server has told us it cannot store tags.
    const tagging = tier.storage.objectTaggingUnsupported ? undefined : encodeTagging(tier.tags);
    try {
      let uploaded;
      try {
        uploaded = await uploadWith(tagging);
      } catch (err) {
        // Checked before the condition outcomes below, and only for a request that carried a
        // `Tagging` header: a provider without tagging support answers the same 501 NotImplemented
        // an unsupported `If-None-Match` does.
        if (tagging === undefined || !isTaggingUnsupported(err)) {
          throw err;
        }
        if (!tier.storage.objectTaggingUnsupported) {
          core.warning(`s3://${bucket} does not support object tags; saved without them.`);
        }
        tier.storage.objectTaggingUnsupported = true;
        uploaded = await uploadWith(undefined);
      }
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
        const uploaded = await attemptUpload(
          undefined,
          tier.storage.objectTaggingUnsupported ? undefined : tagging
        );
        core.info(`Cache saved to S3 with key: ${primaryKey}`);
        return { kind: 'saved', s3: { objectKey, size: uploaded.size, etag: uploaded.etag } };
      }
      throw err;
    }
  } catch (err) {
    return { kind: 'error', error: toError(err) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
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
 * the upload run concurrently, but the upload body is only ever told the archive is complete
 * (`counter.stream.end()`) once tar has actually closed with exit code 0; any other outcome —
 * a non-zero exit, a signal, or the pipe itself breaking — destroys the body with an error
 * first, so lib-storage can never send the final PutObject/CompleteMultipartUpload for a
 * truncated archive. `If-None-Match` would otherwise keep such a bad object forever.
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
  let child: ChildProcess | undefined;
  let tarClose: Promise<number> | undefined;
  // Set once the inner catch below has killed tar and waited for it, so the outer catch (which
  // its rethrow also reaches) does not wait a second time.
  let tarReaped = false;
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

    child = spawnArchiveCommand(command, ['ignore', 'pipe', 'pipe']);
    const stderrTail = captureStderrTail(child.stderr);
    tarClose = waitForExit(child);
    const counter = createByteCounter();
    // A stream this code may `destroy(err)` itself (below) needs a permanent error listener:
    // pipeline's own listener is only attached while it is in flight, and is gone by the time
    // finalizeBody calls destroy() after pipeline has already settled.
    counter.stream.on('error', () => undefined);
    // `end: false`: tar's stdout reaching EOF must never by itself end the upload body — only a
    // confirmed clean exit (below) may do that.
    const pipePromise = pipeline(child.stdout as Readable, counter.stream, { end: false });

    // Captured once and reused (not re-invoked) so every branch below can await the same
    // settlement, whichever of upload.done()/finalizeBody() the outer Promise.all resolved on.
    const finalized = (async (): Promise<void> => {
      let code: number;
      try {
        [, code] = await Promise.all([pipePromise, tarClose]);
      } catch (err) {
        counter.stream.destroy(toError(err));
        throw err;
      }
      if (code !== 0) {
        const failure = new Error(`tar exited with code ${code}`);
        counter.stream.destroy(failure);
        throw failure;
      }
      counter.stream.end();
    })();
    // Keeps `finalized` "handled" from Node's perspective even if nothing below ever awaits it
    // (a synchronous throw between here and the inner try, e.g. from createStreamUpload, would
    // otherwise leave its eventual rejection unhandled, which is fatal on Node 24). The `finalized`
    // binding itself is untouched, so the real await below still observes its outcome.
    finalized.catch(() => undefined);

    const sendCondition = !tier.storage.conditionalWriteUnsupported;
    core.info(`Streaming upload to s3://${bucket}/${objectKey}...`);
    const tagging = tier.storage.objectTaggingUnsupported ? undefined : encodeTagging(tier.tags);
    const upload = createStreamUpload(client, bucket, objectKey, counter.stream, uploadChunkSize, {
      ifNoneMatch: sendCondition ? '*' : undefined,
      tagging,
    });

    // Captured once so the failure path below can wait for it to settle.
    const uploadDone = upload.done();
    try {
      const [uploaded] = await Promise.all([uploadDone, finalized]);
      core.info(`Cache saved to S3 with key: ${primaryKey}`);
      return {
        kind: 'saved',
        s3: { objectKey, size: counter.count(), etag: uploaded.ETag },
      };
    } catch (err) {
      // Fail the body first. When the upload stopped reading it, tar's stdout is paused with data
      // still buffered, so it never closes and tar's close never fires; destroying the body makes
      // pipeline destroy that stdout too. (When tar failed first, finalized already did this.)
      counter.stream.destroy(toError(err));
      // Kill tar before any network wait below, so a hung tar never outlives a slow abort request.
      killIfRunning(child);
      // When tar failed first, the upload may still be running: stop it, then wait for done()
      // to settle, which is where a multipart upload it created gets aborted (see
      // createStreamUpload). abort() makes done() reject promptly, so this wait is short; when
      // done() already rejected, it has already sent the abort and this does nothing.
      await upload.abort().catch(() => undefined);
      await uploadDone.catch(() => undefined);
      // Kill tar again (a no-op when it has exited), then wait, bounded, for it to close,
      // so no failure mode can block this step indefinitely. Wait on tar's own close, not on
      // finalized: once the pipe has failed, finalized rejects while tar may still be alive,
      // and the temp directory must not be removed under a live tar. Only after this do we read
      // the byte count or the final stderr tail below.
      await waitForExitAfterKill(child, tarClose);
      tarReaped = true;
      // Before the condition outcomes below, and only for a request that carried a `Tagging`
      // header: a provider without tagging support answers the same 501 an unsupported
      // `If-None-Match` does. A streamed body cannot be replayed, so the retry without tags is a
      // file-mode save, which omits them once the flag below is set.
      if (tagging !== undefined && isTaggingUnsupported(err)) {
        if (!tier.storage.objectTaggingUnsupported) {
          core.warning(`s3://${bucket} does not support object tags; saved without them.`);
        }
        tier.storage.objectTaggingUnsupported = true;
        return await saveToS3FileMode(tier, objectKey, entries, primaryKey, uploadChunkSize);
      }
      if (sendCondition && isPreconditionFailed(err)) {
        core.info(`Another job saved s3://${bucket}/${objectKey} first; keeping its cache.`);
        return { kind: 'exists', s3: { objectKey, size: counter.count(), etag: undefined } };
      }
      if (sendCondition && isConditionUnsupported(err)) {
        core.debug(
          `s3://${bucket} rejected the If-None-Match condition; retrying the upload of ${objectKey} without it.`
        );
        tier.storage.conditionalWriteUnsupported = true;
        return await saveToS3FileMode(tier, objectKey, entries, primaryKey, uploadChunkSize);
      }
      if (sendCondition && isConditionalConflict(err)) {
        // A streamed body cannot be replayed, so the one retry is a file-mode save, which keeps
        // the condition.
        core.info(
          `A concurrent write to s3://${bucket}/${objectKey} conflicted with this upload; retrying it once from a temporary archive file.`
        );
        return await saveToS3FileMode(tier, objectKey, entries, primaryKey, uploadChunkSize, false);
      }
      throw withStderrTail(err, stderrTail.lines());
    }
  } catch (err) {
    // Reached by the inner catch's rethrow, which has already killed tar and waited for it, and
    // by a failure before the inner try took charge of tar (createStreamUpload throwing, for
    // example). Only the latter still has tar to stop: destroy its stdout, which nothing may be
    // reading, so its close can fire, then kill it and wait, bounded, before removing tempDir.
    if (child && !tarReaped) {
      child.stdout?.destroy();
      if (tarClose) {
        await waitForExitAfterKill(child, tarClose);
      } else {
        killIfRunning(child);
      }
    }
    return { kind: 'error', error: toError(err) };
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
  let body: Readable | undefined;
  let child: ChildProcess | undefined;
  let tarClose: Promise<number> | undefined;
  // Set once the inner catch below has killed tar and waited for it, so the outer catch (which
  // its rethrow also reaches) does not wait a second time.
  let tarReaped = false;
  try {
    const stream = await getObjectStream(client, bucket, found.objectKey);
    body = stream.body;
    const { metadata } = stream;
    fs.mkdirSync(tier.workspace, { recursive: true });
    const [command] = buildExtractCommands({
      tar,
      platform: process.platform,
      compression: tier.compression.method,
      archivePath: '-',
      workspace: tier.workspace,
      tempDir: os.tmpdir(),
    });

    child = spawnArchiveCommand(command, ['pipe', 'ignore', 'pipe']);
    const stderrTail = captureStderrTail(child.stderr);
    tarClose = waitForExit(child);
    // Keeps `tarClose` "handled" from Node's perspective if a synchronous throw below (from
    // createSha256Tap or the pipeline() call itself) reaches the outer catch before the
    // Promise.all below ever attaches its own handler to it.
    tarClose.catch(() => undefined);
    const tap = createSha256Tap();
    const pipePromise = pipeline(body, tap.stream, child.stdin as Writable);

    try {
      const [, code] = await Promise.all([pipePromise, tarClose]);
      if (code !== 0) {
        throw new Error(`tar exited with code ${code}`);
      }
    } catch (err) {
      // tar's stdout is ignored and its stderr is always being read, so a killed tar closes
      // promptly (unlike the save side, nothing here can hold its close back): wait for that
      // before reading the final stderr tail.
      await waitForExitAfterKill(child, tarClose);
      tarReaped = true;
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
    // Reached by the inner catch's rethrow (a failed download, pipe or tar, with tar already
    // killed and waited for there), and by any failure before the inner try took charge: the
    // GetObject request failing, or a throw before or right after spawning tar, before the
    // pipeline started. In the latter case stop tar here: release its stdin, kill it and wait,
    // bounded, for it to close. Either way release the GetObject body, so its connection is
    // never left dangling. The workspace may already hold partly extracted files.
    if (child && !tarReaped) {
      child.stdin?.destroy();
      if (tarClose) {
        await waitForExitAfterKill(child, tarClose);
      } else {
        killIfRunning(child);
      }
    }
    body?.destroy();
    return { kind: 'error', error: toError(err) };
  }
}
