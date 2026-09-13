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
      s3Mock
        .on(HeadObjectCommand, {
          Bucket: 'test-bucket',
          Key: 'existing-key',
        })
        .resolves({
          ContentLength: 1024,
          ETag: '"mock-etag"',
          LastModified: new Date('2026-01-01T00:00:00Z'),
        });

      return checkObjectExists(client, 'test-bucket', 'existing-key').then((meta) => {
        expect(meta).not.toBeNull();
        expect(meta?.size).toBe(1024);
        expect(meta?.etag).toBe('"mock-etag"');
      });
    });

    it('returns null when object is not found (404 / NotFound)', () => {
      const notFoundError = new Error('NotFound');
      notFoundError.name = 'NotFound';
      s3Mock.on(HeadObjectCommand).rejects(notFoundError);

      return checkObjectExists(client, 'test-bucket', 'missing-key').then((meta) => {
        expect(meta).toBeNull();
      });
    });

    it('returns null when error name is NoSuchKey', async () => {
      const err = new Error('NoSuchKey');
      err.name = 'NoSuchKey';
      s3Mock.on(HeadObjectCommand).rejects(err);

      const meta = await checkObjectExists(client, 'test-bucket', 'missing-key');
      expect(meta).toBeNull();
    });

    it('returns null when httpStatusCode is 404', async () => {
      const err = { $metadata: { httpStatusCode: 404 } };
      s3Mock.on(HeadObjectCommand).rejects(err);

      const meta = await checkObjectExists(client, 'test-bucket', 'missing-key');
      expect(meta).toBeNull();
    });

    it('re-throws non-404 error', async () => {
      const err = new Error('AccessDenied');
      s3Mock.on(HeadObjectCommand).rejects(err);

      await expect(checkObjectExists(client, 'test-bucket', 'key')).rejects.toThrow('AccessDenied');
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

      return listObjectsWithPrefix(client, 'test-bucket', 'prefix/').then((items) => {
        expect(items.length).toBe(2);
        expect(items[0].key).toBe('prefix/test1/cache.tar.zst');
        expect(items[0].size).toBe(2048);
        expect(items[1].key).toBe('prefix/test2/cache.tar.zst');
      });
    });

    it('returns empty array when no contents returned', () => {
      s3Mock.on(ListObjectsV2Command).resolves({});

      return listObjectsWithPrefix(client, 'test-bucket', 'empty/').then((items) => {
        expect(items).toEqual([]);
      });
    });
  });

  describe('downloadFile', () => {
    it('pipes S3 GetObject stream to local destination path', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-download-'));
      const destPath = path.join(tempDir, 'subfolder', 'downloaded.txt');

      const mockStream = new Readable();
      mockStream.push('hello-cache-content');
      mockStream.push(null);

      s3Mock.on(GetObjectCommand).resolves({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Body: mockStream as any,
      });

      await downloadFile(client, 'test-bucket', 'sample-key', destPath);

      expect(fs.existsSync(destPath)).toBe(true);
      expect(fs.readFileSync(destPath, 'utf8')).toBe('hello-cache-content');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('throws error when response Body is empty', async () => {
      s3Mock.on(GetObjectCommand).resolves({});
      const tempPath = path.join(os.tmpdir(), 'empty-body-test.txt');

      await expect(downloadFile(client, 'test-bucket', 'empty-key', tempPath)).rejects.toThrow(
        'Empty response body received'
      );
    });
  });

  describe('uploadFile', () => {
    it('uploads file via lib-storage Upload and returns size and etag', async () => {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const { uploadFile } = await import('../../src/storage/operations');

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-upload-'));
      const sampleFile = path.join(tempDir, 'file-to-upload.bin');
      fs.writeFileSync(sampleFile, Buffer.alloc(1024, 'a'));

      s3Mock.on(PutObjectCommand).resolves({
        ETag: '"mocked-etag"',
      });

      const res = await uploadFile(
        client,
        'test-bucket',
        'uploaded-key',
        sampleFile,
        10 * 1024 * 1024
      );

      expect(res.size).toBe(1024);
      expect(res.etag).toBe('"mocked-etag"');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });
});
