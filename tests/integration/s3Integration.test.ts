import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import {
  checkObjectExists,
  uploadFile,
  downloadFile,
  listObjectsWithPrefix,
} from '../../src/storage/operations';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('S3 Storage Integration Tests (Garage / SeaweedFS / S3)', () => {
  const endpoint = process.env.TEST_S3_ENDPOINT || 'http://127.0.0.1:8333';
  const bucket = 'integration-cache-test';
  let client: S3Client;
  let isS3Available = false;

  beforeAll(async () => {
    client = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.TEST_S3_ACCESS_KEY || 'any-access-key',
        secretAccessKey: process.env.TEST_S3_SECRET_KEY || 'any-secret-key',
      },
    });

    try {
      // Check if local S3 service is responding
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      isS3Available = true;
    } catch {
      // If service is not up, skip live integration calls
      isS3Available = false;
    }
  });

  it('runs upload, head, list, and download against S3 server when available', async () => {
    if (!isS3Available) {
      console.log(
        `Skipping live S3 integration test because no S3 server was reachable at ${endpoint}. (Start garage or seaweedfs with docker-compose -f docker-compose.test.yml up to run live)`
      );
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-integ-'));
    const sourceFile = path.join(tempDir, 'source.tar.gz');
    const downloadedFile = path.join(tempDir, 'downloaded.tar.gz');

    fs.writeFileSync(sourceFile, 'test-archive-binary-payload-data');

    const testKey = 'test-repo/integration-test/cache.tar.gz';

    // 1. Upload
    const uploadRes = await uploadFile(client, bucket, testKey, sourceFile);
    expect(uploadRes.size).toBe(fs.statSync(sourceFile).size);

    // 2. Head / checkObjectExists
    const meta = await checkObjectExists(client, bucket, testKey);
    expect(meta).not.toBeNull();
    expect(meta?.size).toBe(uploadRes.size);

    // 3. List with prefix
    const list = await listObjectsWithPrefix(client, bucket, 'test-repo/integration-test');
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].key).toBe(testKey);

    // 4. Download
    await downloadFile(client, bucket, testKey, downloadedFile);
    expect(fs.existsSync(downloadedFile)).toBe(true);
    expect(fs.readFileSync(downloadedFile, 'utf8')).toBe('test-archive-binary-payload-data');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
