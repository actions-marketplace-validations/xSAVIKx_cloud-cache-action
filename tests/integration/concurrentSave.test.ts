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
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GetObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
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
    streaming: false,
    download: { concurrency: 8, partSize: 8 * 1024 * 1024 },
    metadata: {},
    tags: [],
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

/**
 * Reads an object's body directly, without going through restoreFromS3 (which needs a full
 * archive round trip); used to inspect exactly what a raw competing write left behind.
 */
async function readObjectBody(client: S3Client, bucket: string, key: string): Promise<string> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (response.Body as any).transformToString();
}

/**
 * Makes `client`'s conditional write lose a race deterministically: the moment the SDK sends a
 * command whose input carries `IfNoneMatch` (the only conditional write saveToS3 issues), this
 * middleware first puts a competing object for the same key through a separate client, then lets
 * the original request continue (for a multipart upload, the first such command is
 * CreateMultipartUpload, whose input lib-storage builds from the same params). That guarantees the competing write reaches the server before
 * the conditional one, with no sleep and no dependence on how long archiving takes.
 */
function injectRaceOnFirstConditionalWrite(
  client: S3Client,
  raceClient: S3Client,
  bucket: string,
  objectKey: string,
  competitorBody: string
): void {
  let injected = false;
  client.middlewareStack.add(
    (next) => async (args) => {
      const input = args.input as { IfNoneMatch?: string };
      if (!injected && input.IfNoneMatch !== undefined) {
        injected = true;
        await raceClient.send(
          new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: competitorBody })
        );
      }
      return next(args);
    },
    { step: 'initialize' }
  );
}

describe('concurrent saves for the same key', () => {
  itS3(
    'two racing saves both finish without error and the surviving object restores consistently',
    async () => {
      const key = `race-${runId}`;
      const wsA = makeTempDir('race-a');
      const wsB = makeTempDir('race-b');
      const payloadA = 'payload-from-job-A';
      const payloadB = 'payload-from-job-B';
      writeFiles(wsA, { 'payload.txt': payloadA });
      writeFiles(wsB, { 'payload.txt': payloadB });

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

          const stored = await restorePayload(key);
          expect(await restorePayload(key)).toBe(stored);
        } else {
          // SeaweedFS and MinIO enforce the condition: exactly one upload wins, whichever it is,
          // and the restored bytes must be that winner's payload, not the loser's.
          const candidates = [
            { outcome: outcomeA, payload: payloadA },
            { outcome: outcomeB, payload: payloadB },
          ];
          const winners = candidates.filter((c) => c.outcome.kind === 'saved');
          const losers = candidates.filter((c) => c.outcome.kind === 'exists');
          expect(winners).toHaveLength(1);
          expect(losers).toHaveLength(1);

          const restored = await restorePayload(key);
          expect(restored).toBe(winners[0].payload);
          expect(await restorePayload(key)).toBe(restored);
        }
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
      // Small enough to guarantee a single-part PutObject (not multipart), which is where the
      // race is injected below.
      writeFiles(ws, { 'payload.txt': 'payload-from-tier' });
      const competitorBody = 'written-behind-the-tiers-back';
      const raceClient = createTestS3Client(s3);

      try {
        const tier = buildTier(ws);
        const objectKey = tier.template.objectKey('', key);
        injectRaceOnFirstConditionalWrite(
          tier.storage.client,
          raceClient,
          tier.storage.bucket,
          objectKey,
          competitorBody
        );

        const outcome = await saveToS3(tier, key, ['payload.txt']);

        expect(outcome.kind).not.toBe('error');
        if (s3.provider === 'garage') {
          // Garage ignores If-None-Match, so the tier's own upload simply overwrites the
          // competitor's; there is nothing to detect.
          expect(outcome.kind).toBe('saved');
        } else {
          expect(outcome.kind).toBe('exists');
          const stored = await readObjectBody(tier.storage.client, tier.storage.bucket, objectKey);
          expect(stored).toBe(competitorBody);
        }
      } finally {
        removeDir(ws);
      }
    }
  );

  itS3(
    'a multipart save that loses the race reports exists and leaves no incomplete multipart upload',
    async () => {
      const key = `behind-back-multipart-${runId}`;
      const ws = makeTempDir('behind-back-multipart');
      // Random bytes do not compress, so the gzip archive stays well over the 5 MiB part size
      // below and the upload is multipart, with CompleteMultipartUpload carrying the condition.
      fs.writeFileSync(path.join(ws, 'payload.bin'), crypto.randomBytes(12 * 1024 * 1024));
      const competitorBody = 'written-behind-the-multipart-tiers-back';
      const raceClient = createTestS3Client(s3);

      try {
        const tier = buildTier(ws);
        const objectKey = tier.template.objectKey('', key);
        injectRaceOnFirstConditionalWrite(
          tier.storage.client,
          raceClient,
          tier.storage.bucket,
          objectKey,
          competitorBody
        );

        const outcome = await saveToS3(tier, key, ['payload.bin'], 5 * 1024 * 1024);

        expect(outcome.kind).not.toBe('error');
        if (s3.provider === 'garage') {
          expect(outcome.kind).toBe('saved');
        } else {
          expect(outcome.kind).toBe('exists');
          const stored = await readObjectBody(tier.storage.client, tier.storage.bucket, objectKey);
          expect(stored).toBe(competitorBody);
        }

        // Whichever way the race went, the failed CompleteMultipartUpload must not leave its
        // uploaded parts behind.
        const listing = await tier.storage.client.send(
          new ListMultipartUploadsCommand({ Bucket: tier.storage.bucket, Prefix: objectKey })
        );
        expect((listing.Uploads ?? []).filter((upload) => upload.Key === objectKey)).toEqual([]);
      } finally {
        removeDir(ws);
      }
    },
    120_000
  );
});
