export enum Inputs {
  Key = 'key',
  Path = 'path',
  RestoreKeys = 'restore-keys',
  UploadChunkSize = 'upload-chunk-size',
  EnableCrossOsArchive = 'enableCrossOsArchive',
  FailOnCacheMiss = 'fail-on-cache-miss',
  LookupOnly = 'lookup-only',
  ReadOnly = 'read-only',
  SaveAlways = 'save-always',

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
  Retry = 'retry',
  RetryCount = 'retry-count',
  UseFallback = 'use-fallback',
}

export enum Outputs {
  CacheHit = 'cache-hit',
  CachePrimaryKey = 'cache-primary-key',
  CacheMatchedKey = 'cache-matched-key',
  CacheSize = 'cache-size',
  CacheStorageProvider = 'cache-storage-provider',
  CacheS3Key = 'cache-s3-key',
  CacheETag = 'cache-etag',
}

export enum State {
  CachePrimaryKey = 'CACHE_PRIMARY_KEY',
  CacheMatchedKey = 'CACHE_MATCHED_KEY',
  CacheStorageProvider = 'CACHE_STORAGE_PROVIDER',
  CacheS3Key = 'CACHE_S3_KEY',
  CacheBucket = 'CACHE_BUCKET',
  CacheEndpoint = 'CACHE_ENDPOINT',
  CacheRegion = 'CACHE_REGION',
  CacheAccessKey = 'CACHE_ACCESS_KEY',
  CacheSecretKey = 'CACHE_SECRET_KEY',
  CacheSessionToken = 'CACHE_SESSION_TOKEN',
  CacheForcePathStyle = 'CACHE_FORCE_PATH_STYLE',
  CachePrefix = 'CACHE_PREFIX',
  CacheS3KeyPattern = 'CACHE_S3_KEY_PATTERN',
  CacheScopedToRepository = 'CACHE_SCOPED_TO_REPOSITORY',
  CacheRetry = 'CACHE_RETRY',
  CacheRetryCount = 'CACHE_RETRY_COUNT',
  CacheReadOnly = 'CACHE_READ_ONLY',
}

export enum Events {
  Key = 'GITHUB_EVENT_NAME',
}

export const Defaults = {
  DefaultRegion: 'us-east-1',
  DefaultS3KeyPattern: '${GITHUB_REPOSITORY}/${prefix}${key}/${archive_filename}',
  DefaultArchiveFilenameZstd: 'cache.tar.zst',
  DefaultArchiveFilenameGzip: 'cache.tar.gz',
  DefaultRetryCount: 3,
};
