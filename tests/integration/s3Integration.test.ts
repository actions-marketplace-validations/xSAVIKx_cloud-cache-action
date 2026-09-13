import type { S3Client } from '@aws-sdk/client-s3';
import { createTestS3Client, getTestS3Config, prepareTestBucket } from '../support/s3Server';
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
  const s3 = getTestS3Config();
  const endpoint = s3.endpoint;
  const bucket = s3.bucket;
  let client: S3Client;
  let isS3Available = false;

  beforeAll(async () => {
    isS3Available = await prepareTestBucket(s3);
    client = createTestS3Client(s3);
  });

  it('runs upload, head, list, and download against S3 server when available', async () => {
    if (!isS3Available) {
      console.log(
        `Skipping live S3 integration test because no S3 server was reachable at ${endpoint}. (Start garage or seaweedfs with docker compose -f docker-compose.test.yml up to run live)`
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
