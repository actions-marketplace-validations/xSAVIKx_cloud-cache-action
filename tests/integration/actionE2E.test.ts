import { createTestS3Client, getTestS3Config, prepareTestBucket } from '../support/s3Server';
import { saveToS3 } from '../../src/core/saveImpl';
import { restoreFromS3 } from '../../src/core/restoreImpl';
import { getCompressionConfig } from '../../src/archive/compression';
import { StorageContext } from '../../src/storage/client';
import { resolveProviderDefaults } from '../../src/storage/providers';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('End-to-End Cache Lifecycle against Local S3 Containers', () => {
  const s3 = getTestS3Config();
  const bucket = s3.bucket;
  let isS3Available = false;
  let storageContext: StorageContext;

  beforeAll(async () => {
    isS3Available = await prepareTestBucket(s3);
    storageContext = {
      client: createTestS3Client(s3),
      bucket,
      providerConfig: resolveProviderDefaults(s3.endpoint, s3.region, true, s3.provider),
    };
  });

  it('saves and restores real filesystem files with exact primary key match', async () => {
    if (!isS3Available) {
      console.log('Skipping E2E test: local S3 container not reachable.');
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-lifecycle-'));
    const testPayloadDir = path.join(tempDir, 'cache-payload');
    fs.mkdirSync(testPayloadDir, { recursive: true });

    const file1 = path.join(testPayloadDir, 'dep1.txt');
    const file2 = path.join(testPayloadDir, 'dep2.json');
    fs.writeFileSync(file1, 'data-dependency-1-content-here');
    fs.writeFileSync(file2, JSON.stringify({ version: '1.0.0', status: 'ready' }));

    const compression = await getCompressionConfig();
    const primaryKey = `e2e-exact-key-${Date.now()}`;

    // 1. Save to S3
    const saveResult = await saveToS3(
      storageContext,
      primaryKey,
      [testPayloadDir],
      '${key}/${archive_filename}',
      '',
      false,
      false,
      0,
      undefined,
      false,
      compression
    );

    expect(saveResult.size).toBeGreaterThan(0);
    expect(saveResult.s3ObjectKey).toContain(primaryKey);

    // 2. Remove local files to simulate a fresh runner
    fs.rmSync(testPayloadDir, { recursive: true, force: true });
    expect(fs.existsSync(file1)).toBe(false);

    // 3. Restore from S3
    const restoreResult = await restoreFromS3(
      storageContext,
      primaryKey,
      [],
      '${key}/${archive_filename}',
      '',
      false,
      false,
      0,
      false,
      compression
    );

    expect(restoreResult).not.toBeNull();
    expect(restoreResult?.isExactHit).toBe(true);
    expect(restoreResult?.matchedKey).toBe(primaryKey);

    // 4. Verify restored content matches
    expect(fs.existsSync(file1)).toBe(true);
    expect(fs.readFileSync(file1, 'utf8')).toBe('data-dependency-1-content-here');
    expect(fs.existsSync(file2)).toBe(true);

    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('restores files from prefix key when primary key misses', async () => {
    if (!isS3Available) {
      console.log('Skipping E2E test: local S3 container not reachable.');
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-prefix-'));
    const testPayloadDir = path.join(tempDir, 'prefix-payload');
    fs.mkdirSync(testPayloadDir, { recursive: true });

    const file = path.join(testPayloadDir, 'app.config');
    fs.writeFileSync(file, 'CONFIG_ENTRY=true');

    const compression = await getCompressionConfig();
    const prefix = `e2e-prefix-${Date.now()}`;
    const olderKey = `${prefix}-v1`;
    const newerKey = `${prefix}-v2`;

    // 1. Save with olderKey
    await saveToS3(
      storageContext,
      olderKey,
      [testPayloadDir],
      '${key}/${archive_filename}',
      '',
      false,
      false,
      0,
      undefined,
      false,
      compression
    );

    // 2. Delete local directory
    fs.rmSync(testPayloadDir, { recursive: true, force: true });
    expect(fs.existsSync(file)).toBe(false);

    // 3. Restore using newerKey as primary and older prefix as fallback
    const restoreResult = await restoreFromS3(
      storageContext,
      newerKey,
      [prefix],
      '${key}/${archive_filename}',
      '',
      false,
      false,
      0,
      false,
      compression
    );

    expect(restoreResult).not.toBeNull();
    expect(restoreResult?.matchedKey).toBe(olderKey);
    expect(restoreResult?.isExactHit).toBe(false);

    // 4. Verify restored file
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('CONFIG_ENTRY=true');

    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
