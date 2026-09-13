/**
 * Verifies Task 4's conditional-create protection against a real S3 server: two jobs racing to
 * save the same key never end up with a mixed or corrupted object, whether the server enforces
 * `If-None-Match` (SeaweedFS, MinIO) or ignores it (Garage, last-writer-wins). Run against each
 * server in turn (see global-constraints.md for how to start each locally) by pointing
 * TEST_S3_* at it, the same way the other integration suites do.
 *
 * This drives `saveToS3`/`restoreFromS3` directly with independent storage contexts (one S3Client
 * per simulated job) instead of going through `saveImpl` + env vars: two real concurrent jobs
 * each read their own environment once, but two `saveImpl` calls in one test process would race
 * on the same mutable `process.env`, which is a test-harness artifact, not the behaviour under
 * test.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { CompressionConfig } from '../../src/archive/compression';
import { compileKeyTemplate } from '../../src/core/keyTemplate';
import { restoreFromS3, saveToS3, type S3Tier } from '../../src/core/s3Tier';
import type { StorageContext } from '../../src/storage/client';
import { createTestS3Client, getTestS3Config, prepareTestBucket } from '../support/s3Server';
import { makeTempDir, removeDir, writeFiles } from '../support/tempTree';

const s3 = getTestS3Config();
const runId = `${Date.now()}-${process.pid}`;
let available = false;

const itS3 = (name: string, fn: () => Promise<void>, timeout = 60_000): void => {
  it(
    name,
    async () => {
      if (!available) {
        console.log(
          `Skipping "${name}": no S3 server at ${s3.endpoint} (set REQUIRE_S3=1 to fail instead).`
        );
        return;
      }
      await fn();
    },
    timeout
  );
};

beforeAll(async () => {
  available = await prepareTestBucket(s3);
});

const compression: CompressionConfig = { method: 'gzip', archiveFilename: 'cache.tar.gz' };

/** One tier per call, each with its own S3Client, the way two independent job runners would. */
function buildTier(workspace: string): S3Tier {
  const storage: StorageContext = {
    client: createTestS3Client(s3),
    bucket: s3.bucket,
    providerConfig: {
      provider: s3.provider as StorageContext['providerConfig']['provider'],
      region: s3.region,
      forcePathStyle: true,
    },
  };
  const template = compileKeyTemplate({
    pattern: '${key}/${version}/${archive_filename}',
    repository: '',
    prefix: '',
    scopedToRepository: false,
    scopedToRef: false,
    version: 'concurrent-save-test',
    archiveFilename: compression.archiveFilename,
    env: {},
  });
  return {
    storage,
    template,
    restoreRefs: [''],
    saveRef: '',
    compression,
    workspace,
    streamRetries: 0,
  };
}

async function restorePayload(key: string): Promise<string> {
  const restoreWs = makeTempDir('concurrent-restore');
  try {
    const outcome = await restoreFromS3(buildTier(restoreWs), key, [], false);
    expect(outcome.kind).toBe('hit');
    return fs.readFileSync(path.join(restoreWs, 'payload.txt'), 'utf8');
  } finally {
    removeDir(restoreWs);
  }
}

describe('concurrent saves for the same key', () => {
  itS3(
    'two racing saves both finish without error and the surviving object restores consistently',
    async () => {
      const key = `race-${runId}`;
      const wsA = makeTempDir('race-a');
      const wsB = makeTempDir('race-b');
      writeFiles(wsA, { 'payload.txt': 'payload-from-job-A' });
      writeFiles(wsB, { 'payload.txt': 'payload-from-job-B' });

      try {
        const [outcomeA, outcomeB] = await Promise.all([
          saveToS3(buildTier(wsA), key, ['payload.txt']),
          saveToS3(buildTier(wsB), key, ['payload.txt']),
        ]);

        expect(outcomeA.kind).not.toBe('error');
        expect(outcomeB.kind).not.toBe('error');

        if (s3.provider === 'garage') {
          // Garage ignores If-None-Match: last writer wins, and both calls still report success.
          expect(['saved', 'exists']).toContain(outcomeA.kind);
          expect(['saved', 'exists']).toContain(outcomeB.kind);
        } else {
          // SeaweedFS and MinIO enforce the condition: exactly one upload wins.
          expect([outcomeA.kind, outcomeB.kind].sort()).toEqual(['exists', 'saved']);
        }

        const first = await restorePayload(key);
        expect(['payload-from-job-A', 'payload-from-job-B']).toContain(first);
        expect(await restorePayload(key)).toBe(first);
      } finally {
        removeDir(wsA);
        removeDir(wsB);
      }
    }
  );

  itS3(
    'a save raced by a direct write behind its back reports exists instead of clobbering the object',
    async () => {
      const key = `behind-back-${runId}`;
      const ws = makeTempDir('behind-back');
      // A few MB keeps archiving (real tar + gzip) reliably slower than the single HEAD round
      // trip, so the direct write below lands between the tier's HEAD check and its own upload.
      writeFiles(ws, { 'payload.txt': Buffer.alloc(4 * 1024 * 1024, 'a').toString() });

      try {
        const tier = buildTier(ws);
        const objectKey = tier.template.objectKey('', key);

        const savePromise = saveToS3(tier, key, ['payload.txt']);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await tier.storage.client.send(
          new PutObjectCommand({
            Bucket: tier.storage.bucket,
            Key: objectKey,
            Body: 'written-behind-the-tiers-back',
          })
        );

        const outcome = await savePromise;
        expect(outcome.kind).not.toBe('error');
        if (s3.provider !== 'garage') {
          expect(outcome.kind).toBe('exists');
        }
      } finally {
        removeDir(ws);
      }
    }
  );
});
