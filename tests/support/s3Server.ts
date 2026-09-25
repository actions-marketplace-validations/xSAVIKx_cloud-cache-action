import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { pathToFileURL } from 'node:url';

/** Where the integration suite and CI helpers find their S3 server. */
export interface TestS3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  provider: string;
  bucket: string;
  required: boolean;
}

export function getTestS3Config(env: NodeJS.ProcessEnv = process.env): TestS3Config {
  return {
    endpoint: env.TEST_S3_ENDPOINT || 'http://127.0.0.1:8333',
    region: env.TEST_S3_REGION || 'us-east-1',
    accessKeyId: env.TEST_S3_ACCESS_KEY || 'cloudcacheci',
    secretAccessKey: env.TEST_S3_SECRET_KEY || 'cloudcachecisecret',
    provider: env.TEST_S3_PROVIDER || 'seaweedfs',
    bucket: env.TEST_S3_BUCKET || 'cloud-cache-test',
    required: env.REQUIRE_S3 === '1',
  };
}

export function createTestS3Client(config: TestS3Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

/**
 * Creates the test bucket. Resolves false when the server is unusable and S3 is optional,
 * so local runs without a server skip; rejects when REQUIRE_S3=1, so CI cannot skip silently.
 */
export async function prepareTestBucket(config: TestS3Config): Promise<boolean> {
  const client = createTestS3Client(config);
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
    return true;
  } catch (err: unknown) {
    const { name = '', message = String(err) } = err as { name?: string; message?: string };
    if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') {
      return true;
    }
    if (config.required) {
      throw new Error(
        `REQUIRE_S3=1 but the S3 server at ${config.endpoint} is not usable: ${name} ${message}`,
        { cause: err }
      );
    }
    return false;
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = { ...getTestS3Config(), required: true };
  await prepareTestBucket(config);
  console.log(`Bucket ${config.bucket} is ready at ${config.endpoint}`);
}
