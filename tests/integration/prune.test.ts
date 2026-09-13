import * as fs from 'node:fs';
import * as path from 'node:path';
import { HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { Defaults } from '../../src/constants';
import { compileKeyTemplate } from '../../src/core/keyTemplate';
import { pruneCaches } from '../../src/core/prune';
import { saveImpl } from '../../src/core/saveImpl';
import type { StorageContext } from '../../src/storage/client';
import { MemoryState } from '../support/memoryState';
import { createTestS3Client, getTestS3Config, prepareTestBucket } from '../support/s3Server';
import { makeTempDir, removeDir, setEnv, writeFiles } from '../support/tempTree';

const s3 = getTestS3Config();
const runId = `${Date.now()}-${process.pid}`;
let available = false;
let client: S3Client;
let workspace: string;
let outputFile: string;
let restoreEnv: () => void;

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

function setInputs(values: Record<string, string>): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) {
      delete process.env[key];
    }
  }
  const all: Record<string, string> = {
    bucket: s3.bucket,
    endpoint: s3.endpoint,
    region: s3.region,
    provider: s3.provider,
    'access-key': s3.accessKeyId,
    'secret-key': s3.secretAccessKey,
    'force-path-style': 'true',
    retry: 'false',
    ...values,
  };
  for (const [name, value] of Object.entries(all)) {
    process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = value;
  }
}

function takeOutputs(): Record<string, string> {
  const text = fs.readFileSync(outputFile, 'utf8');
  fs.writeFileSync(outputFile, '');
  const outputs: Record<string, string> = {};
  for (const match of text.matchAll(
    /^(.+?)<<(ghadelimiter_[0-9a-f-]+)\r?\n([\s\S]*?)\r?\n\2\r?$/gm
  )) {
    outputs[match[1]] = match[3];
  }
  return outputs;
}

/** Saves one cache through the real S3 tier and returns the object key it was stored under. */
async function saveArchive(
  repository: string,
  ref: string,
  key: string,
  content: string
): Promise<string> {
  writeFiles(workspace, { 'data/f.txt': content });
  process.env.GITHUB_REPOSITORY = repository;
  process.env.GITHUB_REF = ref;
  setInputs({ key, path: 'data' });
  await saveImpl(new MemoryState());
  expect(process.exitCode ?? 0).toBe(0);
  const objectKey = takeOutputs()['cache-s3-key'];
  expect(objectKey).toBeTruthy();
  fs.rmSync(path.join(workspace, 'data'), { recursive: true, force: true });
  return objectKey;
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: key }));
    return true;
  } catch (err: unknown) {
    const error = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

beforeAll(async () => {
  available = await prepareTestBucket(s3);
  client = createTestS3Client(s3);
});

afterAll(() => {
  client.destroy();
});

beforeEach(() => {
  workspace = makeTempDir('prune-ws');
  const scratch = makeTempDir('prune-run');
  outputFile = path.join(scratch, 'output.txt');
  fs.writeFileSync(outputFile, '');
  const eventPath = path.join(scratch, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ repository: { default_branch: 'main' } }));
  restoreEnv = setEnv({
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: outputFile,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: `cloud-cache-it/prune-${runId}`,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_BASE_REF: undefined,
  });
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) {
      delete process.env[key];
    }
  }
  restoreEnv();
  removeDir(workspace);
});

describe('pruneCaches integration', () => {
  itS3(
    'deletes only stale archive objects under the repository/ref prefix, leaving a dry run and other repositories untouched',
    async () => {
      const repository = `cloud-cache-it/prune-${runId}`;
      const otherRepository = `cloud-cache-it/prune-other-${runId}`;

      const featureKey = await saveArchive(repository, 'refs/heads/feature', 'k1', 'feature-data');
      const mainKey = await saveArchive(repository, 'refs/heads/main', 'k2', 'main-data');
      const otherRepoKey = await saveArchive(
        otherRepository,
        'refs/heads/main',
        'k1',
        'other-data'
      );

      // A non-archive object under the same repository/ref prefix must never be touched.
      const strayKey = `${repository}/refs%2Fheads%2Ffeature/stray/notes.txt`;
      await client.send(
        new PutObjectCommand({ Bucket: s3.bucket, Key: strayKey, Body: 'not a cache archive' })
      );

      const template = compileKeyTemplate({
        pattern: Defaults.DefaultS3KeyPattern,
        repository,
        prefix: '',
        scopedToRepository: true,
        scopedToRef: true,
        version: '',
        archiveFilename: 'cache.tar.zst',
        env: {},
      });
      const storage: StorageContext = {
        client,
        bucket: s3.bucket,
        providerConfig: {
          provider: s3.provider as 'seaweedfs',
          region: s3.region,
          forcePathStyle: true,
        },
      };

      // The objects were just created; a `now` far in the future makes them look stale without
      // needing to age real objects on the server.
      const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);

      const dryRun = await pruneCaches(
        { storage, template },
        { olderThanDays: 1, dryRun: true, now: farFuture }
      );
      expect(dryRun.dryRun).toBe(true);
      expect(dryRun.pruned.map((p) => p.key).sort()).toEqual([featureKey, mainKey].sort());
      expect(dryRun.keptCount).toBe(0);

      // A dry run must not have deleted anything.
      expect(await objectExists(featureKey)).toBe(true);
      expect(await objectExists(mainKey)).toBe(true);
      expect(await objectExists(strayKey)).toBe(true);
      expect(await objectExists(otherRepoKey)).toBe(true);

      const real = await pruneCaches(
        { storage, template },
        { olderThanDays: 1, dryRun: false, now: farFuture }
      );
      expect(real.dryRun).toBe(false);
      expect(real.pruned.map((p) => p.key).sort()).toEqual([featureKey, mainKey].sort());

      // The real run deleted both archives under this repository...
      expect(await objectExists(featureKey)).toBe(false);
      expect(await objectExists(mainKey)).toBe(false);
      // ...but left the non-archive object and the other repository's cache alone.
      expect(await objectExists(strayKey)).toBe(true);
      expect(await objectExists(otherRepoKey)).toBe(true);
    }
  );
});
