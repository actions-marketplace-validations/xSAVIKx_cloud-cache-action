import * as core from '@actions/core';
import { DeleteObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { formatSize } from '../utils/inputUtils';
import type { KeyTemplate } from './keyTemplate';
import { toError } from './outcomes';
import type { StorageContext } from '../storage/client';

export interface PruneOptions {
  /** Delete archives whose LastModified is older than this many days. Must be > 0. */
  olderThanDays: number;
  /** Prune only this ref; every ref when omitted. */
  ref?: string;
  /** List candidates without deleting anything. */
  dryRun: boolean;
  /** Reference instant the age cutoff is computed from; defaults to `new Date()`. For tests. */
  now?: Date;
  /** Deletions in flight at once. Defaults to 8. */
  concurrency?: number;
}

export interface PrunedObject {
  key: string;
  size: number;
  lastModified?: Date;
}

export interface PruneResult {
  pruned: PrunedObject[];
  keptCount: number;
  prunedBytes: number;
  dryRun: boolean;
}

/** The subset of an S3 tier pruning needs: no version or restore/save-ref concerns apply. */
export interface PruneTier {
  storage: StorageContext;
  template: KeyTemplate;
}

const DEFAULT_CONCURRENCY = 8;
const LOG_CAP = 200;
const ERROR_SAMPLE_CAP = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The two filenames the action itself ever produces, regardless of key pattern or version. */
const KNOWN_ARCHIVE_FILENAMES = ['cache.tar.zst', 'cache.tar.gz'];

interface ListedObject {
  key: string;
  size: number;
  lastModified?: Date;
}

/**
 * The suffixes (the text a matching object key ends with) that count as a cache archive: the
 * two default filenames, and whatever `template` produces after `${key}` for its own archive
 * filename -- with that filename swapped for the other default when it is one of them, so a
 * repository that has ever used both gzip and zstd gets pruned completely even though a single
 * template only carries one archive filename. The version segment in between does not matter:
 * it never reaches the end of the key, so it cannot break an `endsWith` match.
 */
function archiveSuffixes(template: KeyTemplate, ref: string): string[] {
  const base = template.searchPrefix(ref, '');
  const templateSuffix = template.objectKey(ref, '').slice(base.length);
  const suffixes = new Set(KNOWN_ARCHIVE_FILENAMES.map((name) => `/${name}`));
  if (templateSuffix) {
    suffixes.add(templateSuffix);
    for (const name of KNOWN_ARCHIVE_FILENAMES) {
      if (!templateSuffix.includes(name)) {
        continue;
      }
      for (const other of KNOWN_ARCHIVE_FILENAMES) {
        if (other !== name) {
          suffixes.add(templateSuffix.split(name).join(other));
        }
      }
    }
  }
  return [...suffixes];
}

function isArchiveKey(key: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => suffix !== '' && key.endsWith(suffix));
}

/** Lists every object under `prefix` that `accept` allows, following continuation tokens. */
async function listArchiveObjects(
  client: S3Client,
  bucket: string,
  prefix: string,
  accept: (key: string) => boolean,
  pageSize = 1000
): Promise<ListedObject[]> {
  const objects: ListedObject[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: pageSize,
        ContinuationToken: continuationToken,
      })
    );
    for (const object of page.Contents ?? []) {
      if (!object.Key || !accept(object.Key)) {
        continue;
      }
      objects.push({
        key: object.Key,
        size: object.Size ?? 0,
        lastModified: object.LastModified,
      });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

/** Runs `fn` over `items` with at most `concurrency` calls in flight at once. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) {
        return;
      }
      await fn(items[index]);
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

function logPruned(objects: readonly ListedObject[], now: Date, dryRun: boolean): void {
  const verb = dryRun ? 'Would prune' : 'Pruned';
  for (const object of objects.slice(0, LOG_CAP)) {
    const ageDays = object.lastModified
      ? Math.floor((now.getTime() - object.lastModified.getTime()) / DAY_MS)
      : 0;
    core.info(`${verb} ${object.key} (${formatSize(object.size)}, ${ageDays}d old)`);
  }
  const totalBytes = objects.reduce((total, object) => total + object.size, 0);
  core.info(`${verb} ${objects.length} cache object(s) totaling ${formatSize(totalBytes)}.`);
}

/**
 * Deletes cache archives older than `options.olderThanDays` under the repository/ref prefix
 * `tier.template` resolves, or lists them without deleting when `options.dryRun` is set. Never
 * touches an object outside that prefix, or one that is not a cache archive.
 */
export async function pruneCaches(tier: PruneTier, options: PruneOptions): Promise<PruneResult> {
  const prefix = tier.template.scopePrefix(options.ref);
  if (prefix === '') {
    throw new Error(
      'Refusing to prune: the resolved prefix is empty, which would scan the whole bucket. Set "prefix" or keep "scoped-to-repository" enabled.'
    );
  }

  const { client, bucket } = tier.storage;
  const suffixes = archiveSuffixes(tier.template, options.ref ?? '');
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - options.olderThanDays * DAY_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  const candidates = await listArchiveObjects(client, bucket, prefix, (key) =>
    isArchiveKey(key, suffixes)
  );
  const stale = candidates.filter(
    (object) => object.lastModified !== undefined && object.lastModified.getTime() < cutoff
  );
  const keptCount = candidates.length - stale.length;

  const deletedKeys = new Set<string>();
  const failures: Array<{ key: string; error: unknown }> = [];
  if (!options.dryRun) {
    await mapWithConcurrency(stale, concurrency, async (object) => {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.key }));
        deletedKeys.add(object.key);
      } catch (err) {
        failures.push({ key: object.key, error: err });
      }
    });
  }

  const prunedObjects = options.dryRun
    ? stale
    : stale.filter((object) => deletedKeys.has(object.key));
  logPruned(prunedObjects, now, options.dryRun);

  if (failures.length > 0) {
    const sample = failures.slice(0, ERROR_SAMPLE_CAP).map((failure) => failure.key);
    const more =
      failures.length > ERROR_SAMPLE_CAP ? `, and ${failures.length - ERROR_SAMPLE_CAP} more` : '';
    throw new AggregateError(
      failures.map((failure) => toError(failure.error)),
      `Failed to delete ${failures.length} cache object(s): ${sample.join(', ')}${more}`
    );
  }

  return {
    pruned: prunedObjects.map(({ key, size, lastModified }) => ({ key, size, lastModified })),
    keptCount,
    prunedBytes: prunedObjects.reduce((total, object) => total + object.size, 0),
    dryRun: options.dryRun,
  };
}
