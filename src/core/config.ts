import * as core from '@actions/core';
import { Defaults, Inputs, State } from '../constants';
import { parseMetadata, parseTags, type ObjectTag } from './objectAttributes';
import type { IStateProvider } from '../state';
import {
  getInputAsArray,
  getInputAsBool,
  getInputAsEnum,
  getInputAsInt,
} from '../utils/inputUtils';

export const RESTORE_PRIORITIES = ['s3-first', 'github-first'] as const;
export const DUAL_CACHE_STRATEGIES = ['backfill', 'skip-on-hit'] as const;
export type RestorePriority = (typeof RESTORE_PRIORITIES)[number];
export type DualCacheStrategy = (typeof DUAL_CACHE_STRATEGIES)[number];

/** Every input the restore and save steps act on, parsed and defaulted once. */
export interface CacheConfig {
  primaryKey: string;
  paths: string[];
  restoreKeys: string[];
  lookupOnly: boolean;
  failOnCacheMiss: boolean;
  readOnly: boolean;
  enableCrossOsArchive: boolean;
  uploadChunkSize?: number;
  s3KeyPattern: string;
  prefix: string;
  scopedToRepository: boolean;
  scopedToRef: boolean;
  retryEnabled: boolean;
  retryCount: number;
  useFallback: boolean;
  dualCache: boolean;
  restorePriority: RestorePriority;
  dualCacheStrategy: DualCacheStrategy;
  dualCacheStrict: boolean;
  streaming: boolean;
  jobSummary: boolean;
  /** User metadata written on every object this step saves (Task 1 parsing rules). */
  metadata: Record<string, string>;
  /** Object tags written on every object this step saves. */
  tags: ObjectTag[];
}

function readDualCacheStrategy(): DualCacheStrategy {
  if (core.getInput(Inputs.DualCacheStrategy).trim() === 'independent') {
    core.warning(
      'dual-cache-strategy "independent" was removed in v1.1; using "backfill", which now checks each tier before uploading.'
    );
    return 'backfill';
  }
  return getInputAsEnum(Inputs.DualCacheStrategy, DUAL_CACHE_STRATEGIES, 'backfill');
}

/**
 * Reads the action inputs. When `state` is given (the post step), values the restore step
 * persisted win, so both steps compute the same object keys and warnings are not repeated.
 */
export function readCacheConfig(state?: IStateProvider): CacheConfig {
  const persisted = (key: State): string => state?.getState(key) ?? '';
  const bool = (key: State, read: () => boolean): boolean => {
    const value = persisted(key);
    return value === '' ? read() : value === 'true';
  };
  const text = <T extends string>(key: State, read: () => T): T => (persisted(key) as T) || read();
  const json = <T>(key: State, read: () => T): T => {
    const value = persisted(key);
    return value === '' ? read() : (JSON.parse(value) as T);
  };
  const retryCountState = persisted(State.CacheRetryCount);

  return {
    primaryKey: text(State.CachePrimaryKey, () => core.getInput(Inputs.Key).trim()),
    paths: getInputAsArray(Inputs.Path),
    restoreKeys: getInputAsArray(Inputs.RestoreKeys),
    lookupOnly: getInputAsBool(Inputs.LookupOnly),
    failOnCacheMiss: getInputAsBool(Inputs.FailOnCacheMiss),
    readOnly: bool(State.CacheReadOnly, () => getInputAsBool(Inputs.ReadOnly)),
    enableCrossOsArchive: getInputAsBool(Inputs.EnableCrossOsArchive),
    uploadChunkSize: getInputAsInt(Inputs.UploadChunkSize),
    s3KeyPattern: text(
      State.CacheS3KeyPattern,
      () => core.getInput(Inputs.S3KeyPattern) || Defaults.DefaultS3KeyPattern
    ),
    prefix: text(State.CachePrefix, () => core.getInput(Inputs.Prefix)),
    scopedToRepository: bool(State.CacheScopedToRepository, () =>
      getInputAsBool(Inputs.ScopedToRepository, true)
    ),
    scopedToRef: bool(State.CacheScopedToRef, () => getInputAsBool(Inputs.ScopedToRef, true)),
    retryEnabled: bool(State.CacheRetry, () => getInputAsBool(Inputs.Retry, true)),
    retryCount:
      retryCountState !== ''
        ? Number(retryCountState)
        : (getInputAsInt(Inputs.RetryCount) ?? Defaults.DefaultRetryCount),
    useFallback: getInputAsBool(Inputs.UseFallback),
    dualCache: bool(State.CacheDualCache, () => getInputAsBool(Inputs.DualCache)),
    restorePriority: text(State.CacheRestorePriority, () =>
      getInputAsEnum(Inputs.RestorePriority, RESTORE_PRIORITIES, 's3-first')
    ),
    dualCacheStrategy: text(State.CacheDualCacheStrategy, readDualCacheStrategy),
    dualCacheStrict: bool(State.CacheDualCacheStrict, () => getInputAsBool(Inputs.DualCacheStrict)),
    streaming: bool(State.CacheStreaming, () => getInputAsBool(Inputs.Streaming)),
    jobSummary: bool(State.CacheJobSummary, () => getInputAsBool(Inputs.JobSummary, true)),
    metadata: json(State.CacheMetadata, () => parseMetadata(core.getInput(Inputs.Metadata))),
    tags: json(State.CacheTags, () => parseTags(core.getInput(Inputs.Tags))),
  };
}

/** Saves what the post step must agree on with the restore step. */
export function persistCacheConfig(state: IStateProvider, config: CacheConfig): void {
  state.setState(State.CachePrimaryKey, config.primaryKey);
  state.setState(State.CacheReadOnly, String(config.readOnly));
  state.setState(State.CacheS3KeyPattern, config.s3KeyPattern);
  state.setState(State.CachePrefix, config.prefix);
  state.setState(State.CacheScopedToRepository, String(config.scopedToRepository));
  state.setState(State.CacheScopedToRef, String(config.scopedToRef));
  state.setState(State.CacheRetry, String(config.retryEnabled));
  state.setState(State.CacheRetryCount, String(config.retryCount));
  state.setState(State.CacheDualCache, String(config.dualCache));
  state.setState(State.CacheRestorePriority, config.restorePriority);
  state.setState(State.CacheDualCacheStrategy, config.dualCacheStrategy);
  state.setState(State.CacheDualCacheStrict, String(config.dualCacheStrict));
  state.setState(State.CacheStreaming, String(config.streaming));
  state.setState(State.CacheJobSummary, String(config.jobSummary));
  state.setState(State.CacheMetadata, JSON.stringify(config.metadata));
  state.setState(State.CacheTags, JSON.stringify(config.tags));
}
