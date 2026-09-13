import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  HeadObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { checkObjectExists, downloadFile, findNewestObject } from '../../src/storage/operations';
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

  describe('findNewestObject', () => {
    const object = (key: string, minute: number) => ({
      Key: key,
      Size: 10 + minute,
      ETag: `"${minute}"`,
      LastModified: new Date(Date.UTC(2026, 8, 13, 10, minute)),
    });
    const pages: Record<string, object> = {
      start: {
        Contents: [object('p/a/cache.tar.zst', 1), object('p/b/cache.tar.zst', 5)],
        IsTruncated: true,
        NextContinuationToken: 't1',
      },
      t1: {
        Contents: [object('p/c/cache.tar.gz', 30)],
        IsTruncated: true,
        NextContinuationToken: 't2',
      },
      t2: { Contents: [object('p/d/cache.tar.zst', 20)], IsTruncated: false },
    };

    it('follows continuation tokens and returns the newest accepted object', async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .callsFake(
          (input: { ContinuationToken?: string }) => pages[input.ContinuationToken ?? 'start']
        );

      const newest = await findNewestObject(client, 'bucket', 'p/', (key) => key.endsWith('.zst'));

      expect(newest).toEqual({
        key: 'p/d/cache.tar.zst',
        size: 30,
        etag: '"20"',
        lastModified: new Date(Date.UTC(2026, 8, 13, 10, 20)),
      });
      const calls = s3Mock.commandCalls(ListObjectsV2Command).map((call) => call.args[0].input);
      expect(calls.map((input) => input.ContinuationToken)).toEqual([undefined, 't1', 't2']);
      expect(calls[0]).toMatchObject({ Bucket: 'bucket', Prefix: 'p/', MaxKeys: 1000 });
    });

    it('returns undefined when no object is accepted', async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .callsFake(
          (input: { ContinuationToken?: string }) => pages[input.ContinuationToken ?? 'start']
        );
      await expect(findNewestObject(client, 'bucket', 'p/', () => false)).resolves.toBeUndefined();
    });

    it('keeps the first object listed when timestamps tie', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [object('p/x/cache.tar.zst', 7), object('p/y/cache.tar.zst', 7)],
        IsTruncated: false,
      });
      expect((await findNewestObject(client, 'bucket', 'p/', () => true))?.key).toBe(
        'p/x/cache.tar.zst'
      );
    });

    it('handles an empty listing', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({});
      await expect(findNewestObject(client, 'bucket', 'p/', () => true)).resolves.toBeUndefined();
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

    it('returns the object metadata from the GetObject response', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-download-'));
      const destPath = path.join(tempDir, 'with-metadata.txt');
      const mockStream = new Readable();
      mockStream.push('data');
      mockStream.push(null);

      s3Mock.on(GetObjectCommand).resolves({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Body: mockStream as any,
        Metadata: { 'cloud-cache-sha256': 'abc123' },
      });

      const result = await downloadFile(client, 'test-bucket', 'sample-key', destPath);
      expect(result.metadata).toEqual({ 'cloud-cache-sha256': 'abc123' });

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('leaves metadata undefined when the response carries none', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-download-'));
      const destPath = path.join(tempDir, 'no-metadata.txt');
      const mockStream = new Readable();
      mockStream.push('data');
      mockStream.push(null);

      s3Mock.on(GetObjectCommand).resolves({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Body: mockStream as any,
      });

      const result = await downloadFile(client, 'test-bucket', 'sample-key', destPath);
      expect(result.metadata).toBeUndefined();

      fs.rmSync(tempDir, { recursive: true, force: true });
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

    it.each([
      ['at exactly 5 MiB, the S3 minimum, as 5 MiB parts', 5 * 1024 * 1024, 3],
      ['just under 5 MiB as 10 MiB parts', 5 * 1024 * 1024 - 1, 2],
      ['unset as 10 MiB parts', undefined, 2],
    ])('uploads 12 MiB with the chunk size %s', async (_label, chunkSize, parts) => {
      const { CompleteMultipartUploadCommand, CreateMultipartUploadCommand, UploadPartCommand } =
        await import('@aws-sdk/client-s3');
      const { uploadFile } = await import('../../src/storage/operations');

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-upload-'));
      const sampleFile = path.join(tempDir, 'large.bin');
      fs.writeFileSync(sampleFile, Buffer.alloc(12 * 1024 * 1024, 'a'));
      s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-1' });
      s3Mock.on(UploadPartCommand).resolves({ ETag: '"part"' });
      s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"multipart"' });

      try {
        await uploadFile(client, 'test-bucket', 'large-key', sampleFile, chunkSize);
        expect(s3Mock.commandCalls(UploadPartCommand)).toHaveLength(parts);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('passes metadata and ifNoneMatch through to a single-part PutObject', async () => {
      const { uploadFile } = await import('../../src/storage/operations');

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-upload-'));
      const sampleFile = path.join(tempDir, 'small.bin');
      fs.writeFileSync(sampleFile, Buffer.alloc(1024, 'a'));
      s3Mock.on(PutObjectCommand).resolves({ ETag: '"mocked-etag"' });

      try {
        await uploadFile(client, 'test-bucket', 'meta-key', sampleFile, undefined, {
          metadata: { 'cloud-cache-sha256': 'deadbeef' },
          ifNoneMatch: '*',
        });
        const [call] = s3Mock.commandCalls(PutObjectCommand);
        expect(call.args[0].input).toMatchObject({
          Metadata: { 'cloud-cache-sha256': 'deadbeef' },
          IfNoneMatch: '*',
        });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('passes metadata and ifNoneMatch through to a multipart upload', async () => {
      const { CompleteMultipartUploadCommand, UploadPartCommand } = await import(
        '@aws-sdk/client-s3'
      );
      const { uploadFile } = await import('../../src/storage/operations');

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-upload-'));
      const sampleFile = path.join(tempDir, 'large-meta.bin');
      fs.writeFileSync(sampleFile, Buffer.alloc(12 * 1024 * 1024, 'a'));
      s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-1' });
      s3Mock.on(UploadPartCommand).resolves({ ETag: '"part"' });
      s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"multipart"' });

      try {
        await uploadFile(client, 'test-bucket', 'large-meta-key', sampleFile, undefined, {
          metadata: { 'cloud-cache-sha256': 'feedface' },
          ifNoneMatch: '*',
        });
        const [call] = s3Mock.commandCalls(CreateMultipartUploadCommand);
        expect(call.args[0].input).toMatchObject({
          Metadata: { 'cloud-cache-sha256': 'feedface' },
        });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('passes ifNoneMatch through to CompleteMultipartUploadCommand, where the condition takes effect', async () => {
      const { uploadFile } = await import('../../src/storage/operations');

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-upload-'));
      const sampleFile = path.join(tempDir, 'large-condition.bin');
      fs.writeFileSync(sampleFile, Buffer.alloc(12 * 1024 * 1024, 'a'));
      s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-1' });
      s3Mock.on(UploadPartCommand).resolves({ ETag: '"part"' });
      s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"multipart"' });

      try {
        await uploadFile(client, 'test-bucket', 'large-condition-key', sampleFile, undefined, {
          ifNoneMatch: '*',
        });
        const [call] = s3Mock.commandCalls(CompleteMultipartUploadCommand);
        expect(call.args[0].input).toMatchObject({ IfNoneMatch: '*' });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
