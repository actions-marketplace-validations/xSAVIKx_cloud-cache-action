import * as path from 'path';
import {
  normalizeS3Key,
  buildS3ObjectKey,
  buildS3SearchPrefix,
  extractKeyFromS3Object,
  normalizePrefix,
  resolveArchivePaths,
} from '../../src/utils/pathUtils';

describe('Path and S3 Key Utilities', () => {
  describe('normalizeS3Key', () => {
    it('converts Windows backslashes to forward slashes', () => {
      expect(normalizeS3Key('my-repo\\caches\\build-123\\cache.tzst')).toBe(
        'my-repo/caches/build-123/cache.tzst'
      );
    });

    it('collapses multiple forward slashes', () => {
      expect(normalizeS3Key('my-repo///sub//key/')).toBe('my-repo/sub/key/');
    });

    it('strips leading slash', () => {
      expect(normalizeS3Key('/my-bucket-prefix/key')).toBe('my-bucket-prefix/key');
    });
  });

  describe('normalizePrefix', () => {
    it('appends trailing slash if missing and strips leading slash', () => {
      expect(normalizePrefix('subfolder/ci')).toBe('subfolder/ci/');
      expect(normalizePrefix('/subfolder/ci/')).toBe('subfolder/ci/');
      expect(normalizePrefix('')).toBe('');
    });
  });

  describe('buildS3ObjectKey', () => {
    it('builds default key scoped to GITHUB_REPOSITORY', () => {
      const key = buildS3ObjectKey({
        repository: 'owner/my-repo',
        key: 'node-deps-123',
        archiveFilename: 'cache.tar.zst',
      });
      expect(key).toBe('owner/my-repo/node-deps-123/cache.tar.zst');
    });

    it('incorporates prefix cleanly', () => {
      const key = buildS3ObjectKey({
        repository: 'owner/my-repo',
        prefix: 'ci/frontend',
        key: 'node-deps-123',
        archiveFilename: 'cache.tar.zst',
      });
      expect(key).toBe('owner/my-repo/ci/frontend/node-deps-123/cache.tar.zst');
    });

    it('omits repository when scopedToRepository is false', () => {
      const key = buildS3ObjectKey({
        repository: 'owner/my-repo',
        scopedToRepository: false,
        key: 'shared-cache-123',
        archiveFilename: 'cache.tar.zst',
      });
      expect(key).toBe('shared-cache-123/cache.tar.zst');
    });

    it('supports custom template patterns', () => {
      const customKey = buildS3ObjectKey({
        repository: 'owner/repo',
        prefix: 'v2',
        key: 'build-hash',
        archiveFilename: 'cache.tar.zst',
        pattern: 'custom-prefix/${prefix}${key}.tar.zst',
      });
      expect(customKey).toBe('custom-prefix/v2/build-hash.tar.zst');
    });

    it('interpolates environment variables into S3 key pattern', () => {
      const mockEnv: NodeJS.ProcessEnv = {
        GITHUB_REPOSITORY: 'owner/repo',
        RUNNER_OS: 'Linux',
        GITHUB_JOB: 'integration-tests',
        WORKLOAD_NAME: 'api-service',
        CUSTOM_RUN_ID: '45678',
      };

      const key = buildS3ObjectKey(
        {
          key: 'primary-cache-key',
          archiveFilename: 'cache.tar.zst',
          pattern:
            '${GITHUB_REPOSITORY}/${RUNNER_OS}/${GITHUB_JOB}/${WORKLOAD_NAME}/${key}/${archive_filename}',
        },
        mockEnv
      );

      expect(key).toBe(
        'owner/repo/Linux/integration-tests/api-service/primary-cache-key/cache.tar.zst'
      );
    });

    it('supports ${env.VAR_NAME} and $VAR_NAME syntax for environment variables', () => {
      const mockEnv: NodeJS.ProcessEnv = {
        GITHUB_REPOSITORY: 'owner/repo',
        NODE_VERSION: '20',
        BUILD_TARGET: 'release',
      };

      const key = buildS3ObjectKey(
        {
          key: 'cache-key',
          archiveFilename: 'cache.tar.zst',
          pattern:
            '${GITHUB_REPOSITORY}/${env.NODE_VERSION}/$BUILD_TARGET/${key}/${archive_filename}',
        },
        mockEnv
      );

      expect(key).toBe('owner/repo/20/release/cache-key/cache.tar.zst');
    });
  });

  describe('buildS3SearchPrefix', () => {
    it('generates prefix for restore key lookup', () => {
      const searchPrefix = buildS3SearchPrefix('node-deps-', {
        repository: 'owner/my-repo',
        prefix: 'ci',
      });
      expect(searchPrefix).toBe('owner/my-repo/ci/node-deps-');
    });

    it('generates prefix when unscoped', () => {
      const searchPrefix = buildS3SearchPrefix('node-deps-', {
        repository: 'owner/my-repo',
        scopedToRepository: false,
      });
      expect(searchPrefix).toBe('node-deps-');
    });

    it('interpolates environment variables into search prefix', () => {
      const mockEnv: NodeJS.ProcessEnv = {
        GITHUB_REPOSITORY: 'owner/repo',
        RUNNER_OS: 'macOS',
        WORKLOAD_ID: 'worker-queue',
      };

      const searchPrefix = buildS3SearchPrefix(
        'restore-key-prefix-',
        {
          pattern: '${GITHUB_REPOSITORY}/${RUNNER_OS}/${WORKLOAD_ID}/${key}/${archive_filename}',
        },
        mockEnv
      );

      expect(searchPrefix).toBe('owner/repo/macOS/worker-queue/restore-key-prefix-');
    });
  });

  describe('extractKeyFromS3Object', () => {
    it('extracts cache key name from complete S3 path', () => {
      const fullKey = 'owner/my-repo/ci/node-deps-xyz/cache.tar.zst';
      const extracted = extractKeyFromS3Object(
        fullKey,
        'owner/my-repo/ci/node-deps-',
        'cache.tar.zst'
      );
      expect(extracted).toBe('node-deps-xyz');
    });

    it('extracts cache key name when filename is directly adjacent', () => {
      const fullKey = 'owner/my-repo/node-deps-xyzcache.tar.zst';
      const extracted = extractKeyFromS3Object(
        fullKey,
        'owner/my-repo/node-deps-',
        'cache.tar.zst'
      );
      expect(extracted).toBe('node-deps-xyz');
    });
  });

  describe('buildS3SearchPrefix fallback', () => {
    it('falls back cleanly when pattern does not contain key placeholder', () => {
      const searchPrefix = buildS3SearchPrefix('restore-prefix-', {
        repository: 'owner/repo',
        prefix: 'ci/',
        pattern: 'static/prefix/without/placeholder',
      });
      expect(searchPrefix).toBe('owner/repo/ci/restore-prefix-');
    });
  });

  describe('resolveArchivePaths', () => {
    it('converts absolute paths relative to cwd and leaves relative paths intact', () => {
      const cwd = process.cwd();
      const absPath = path.join(cwd, 'dist', 'bundle.js');
      const relPath = 'src/index.ts';

      const resolved = resolveArchivePaths([absPath, relPath]);
      expect(resolved[0]).toBe(path.join('dist', 'bundle.js'));
      expect(resolved[1]).toBe('src/index.ts');
    });
  });
});
