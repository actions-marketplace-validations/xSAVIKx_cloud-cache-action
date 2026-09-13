export enum Inputs {
  Key = 'key',
  Path = 'path',
  RestoreKeys = 'restore-keys',
  UploadChunkSize = 'upload-chunk-size',
  EnableCrossOsArchive = 'enableCrossOsArchive',
  FailOnCacheMiss = 'fail-on-cache-miss',
  LookupOnly = 'lookup-only',
  ReadOnly = 'read-only',

  Bucket = 'bucket',
  Endpoint = 'endpoint',
  Region = 'region',
  Provider = 'provider',
  AccessKey = 'access-key',
  AccessKeyCamel = 'accessKey',
  SecretKey = 'secret-key',
  SecretKeyCamel = 'secretKey',
  SessionToken = 'session-token',
  SessionTokenCamel = 'sessionToken',
  ForcePathStyle = 'force-path-style',
  Prefix = 'prefix',
  S3KeyPattern = 's3-key-pattern',
  ScopedToRepository = 'scoped-to-repository',
  ScopedToRef = 'scoped-to-ref',
  Retry = 'retry',
  RetryCount = 'retry-count',
  UseFallback = 'use-fallback',

  // Dual-cache inputs
  DualCache = 'dual-cache',
  RestorePriority = 'restore-priority',
  DualCacheStrategy = 'dual-cache-strategy',
  DualCacheStrict = 'dual-cache-strict',
}

export enum Outputs {
  CacheHit = 'cache-hit',
  CachePrimaryKey = 'cache-primary-key',
  CacheMatchedKey = 'cache-matched-key',
  CacheSize = 'cache-size',
  CacheStorageProvider = 'cache-storage-provider',
  CacheS3Key = 'cache-s3-key',
  CacheETag = 'cache-etag',

  // Dual-cache outputs
  CacheHitSource = 'cache-hit-source',
  CacheSavedSources = 'cache-saved-sources',
}

export enum State {
  CachePrimaryKey = 'CACHE_PRIMARY_KEY',
  CacheMatchedKey = 'CACHE_MATCHED_KEY',
  CacheStorageProvider = 'CACHE_STORAGE_PROVIDER',
  CacheS3Key = 'CACHE_S3_KEY',
  CachePrefix = 'CACHE_PREFIX',
  CacheS3KeyPattern = 'CACHE_S3_KEY_PATTERN',
  CacheScopedToRepository = 'CACHE_SCOPED_TO_REPOSITORY',
  CacheScopedToRef = 'CACHE_SCOPED_TO_REF',
  CacheRetry = 'CACHE_RETRY',
  CacheRetryCount = 'CACHE_RETRY_COUNT',
  CacheReadOnly = 'CACHE_READ_ONLY',
  CacheCompression = 'CACHE_COMPRESSION',

  // Dual-cache state
  CacheDualCache = 'CACHE_DUAL_CACHE',
  CacheRestorePriority = 'CACHE_RESTORE_PRIORITY',
  CacheDualCacheStrategy = 'CACHE_DUAL_CACHE_STRATEGY',
  CacheDualCacheStrict = 'CACHE_DUAL_CACHE_STRICT',
  CacheS3ExactHit = 'CACHE_S3_EXACT_HIT',
  CacheGithubExactHit = 'CACHE_GITHUB_EXACT_HIT',
  CacheHitSource = 'CACHE_HIT_SOURCE',
}

export enum Events {
  Key = 'GITHUB_EVENT_NAME',
}

export const Defaults = {
  DefaultRegion: 'us-east-1',
  DefaultS3KeyPattern: '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}',
  DefaultArchiveFilenameZstd: 'cache.tar.zst',
  DefaultArchiveFilenameGzip: 'cache.tar.gz',
  DefaultRetryCount: 3,
  DefaultRestorePriority: 's3-first',
  DefaultDualCacheStrategy: 'backfill',
  /** Mixed into every cache version; bump it when the archive format changes incompatibly. */
  VersionSalt: 'cloud-cache-1',
};
