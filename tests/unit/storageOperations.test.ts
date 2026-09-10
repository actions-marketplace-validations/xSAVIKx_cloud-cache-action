import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  HeadObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import {
  checkObjectExists,
  listObjectsWithPrefix,
  downloadFile,
} from '../../src/storage/operations';
import { withRetry } from '../../src/storage/retry';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Readable } from 'stream';

const s3Mock = mockClient(S3Client);

describe('Storage Operations', () => {
  let client: S3Client;

  beforeEach(() => {
    s3Mock.reset();
    client = new S3Client({ region: 'us-east-1' });
  });

  describe('checkObjectExists', () => {
    it('returns metadata when object exists', () => {
      s3Mock.on(HeadObjectCommand, {
        Bucket: 'test-bucket',
        Key: 'existing-key',
      }).resolves({
        ContentLength: 1024,
        ETag: '"mock-etag"',
        LastModified: new Date('2026-01-01T00:00:00Z'),
      });

      return checkObjectExists(client, 'test-bucket', 'existing-key').then(
        (meta) => {
          expect(meta).not.toBeNull();
          expect(meta?.size).toBe(1024);
          expect(meta?.etag).toBe('"mock-etag"');
        }
      );
    });

    it('returns null when object is not found (404 / NotFound)', () => {
      const notFoundError = new Error('NotFound');
      notFoundError.name = 'NotFound';
      s3Mock.on(HeadObjectCommand).rejects(notFoundError);

      return checkObjectExists(client, 'test-bucket', 'missing-key').then(
        (meta) => {
          expect(meta).toBeNull();
        }
      );
    });
  });

  describe('listObjectsWithPrefix', () => {
    it('returns filtered and mapped objects list', () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [
          {
            Key: 'prefix/test1/cache.tar.zst',
            Size: 2048,
            LastModified: new Date('2026-01-01'),
            ETag: '"etag-1"',
          },
          {
            Key: 'prefix/test2/cache.tar.zst',
            Size: 4096,
            LastModified: new Date('2026-01-02'),
            ETag: '"etag-2"',
          },
        ],
      });

      return listObjectsWithPrefix(client, 'test-bucket', 'prefix/').then(
        (items) => {
          expect(items.length).toBe(2);
          expect(items[0].key).toBe('prefix/test1/cache.tar.zst');
          expect(items[0].size).toBe(2048);
          expect(items[1].key).toBe('prefix/test2/cache.tar.zst');
        }
      );
    });

    it('returns empty array when no contents returned', () => {
      s3Mock.on(ListObjectsV2Command).resolves({});

      return listObjectsWithPrefix(client, 'test-bucket', 'empty/').then(
        (items) => {
          expect(items).toEqual([]);
        }
      );
    });
  });

  describe('downloadFile', () => {
    it('pipes S3 GetObject stream to local destination path', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-download-'));
      const destPath = path.join(tempDir, 'downloaded.txt');

      const mockStream = new Readable();
      mockStream.push('hello-cache-content');
      mockStream.push(null);

      s3Mock.on(GetObjectCommand).resolves({
        Body: mockStream as any,
      });

      await downloadFile(client, 'test-bucket', 'sample-key', destPath);

      expect(fs.existsSync(destPath)).toBe(true);
      expect(fs.readFileSync(destPath, 'utf8')).toBe('hello-cache-content');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('withRetry', () => {
    it('retries until success within limit', async () => {
      let attempts = 0;
      const fn = jest.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Transient error');
        }
        return 'success';
      });

      const result = await withRetry(fn, {
        retries: 3,
        minTimeoutMs: 10,
        factor: 1,
      });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('throws if all retries are exhausted', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('Permanent failure'));

      await expect(
        withRetry(fn, {
          retries: 2,
          minTimeoutMs: 10,
          factor: 1,
        })
      ).rejects.toThrow('Permanent failure');

      expect(fn).toHaveBeenCalledTimes(3);
    });
  });
});
