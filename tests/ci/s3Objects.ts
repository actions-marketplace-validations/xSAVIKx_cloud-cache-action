/**
 * Moves cache objects between S3 servers that cannot see each other, and cleans up after live
 * runs. Uses the TEST_S3_* configuration from tests/support/s3Server.ts.
 *
 *   node tests/ci/s3Objects.ts export <dir> <prefix> <contains>
 *   node tests/ci/s3Objects.ts import <dir>
 *   node tests/ci/s3Objects.ts delete <prefix> <contains>
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTestS3Client, getTestS3Config } from '../support/s3Server.ts';

interface ExportIndex {
  objects: Array<{ key: string; file: string }>;
}

async function listKeys(
  client: S3Client,
  bucket: string,
  prefix: string,
  contains: string
): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
    );
    for (const object of page.Contents ?? []) {
      if (object.Key?.includes(contains)) {
        keys.push(object.Key);
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const config = getTestS3Config();
  const client = createTestS3Client(config);
  const bucket = config.bucket;

  try {
    if (command === 'export') {
      const [dir, prefix, contains] = args;
      const keys = await listKeys(client, bucket, prefix, contains);
      if (keys.length === 0) {
        throw new Error(`No objects under "${prefix}" contain "${contains}"`);
      }
      fs.mkdirSync(dir, { recursive: true });
      const index: ExportIndex = { objects: [] };
      for (const [position, key] of keys.entries()) {
        const file = `object-${position}.bin`;
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        fs.writeFileSync(path.join(dir, file), await response.Body!.transformToByteArray());
        index.objects.push({ key, file });
      }
      fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2));
      console.log(`Exported ${keys.length} object(s):\n${keys.join('\n')}`);
    } else if (command === 'import') {
      const [dir] = args;
      const index = JSON.parse(
        fs.readFileSync(path.join(dir, 'index.json'), 'utf8')
      ) as ExportIndex;
      for (const { key, file } of index.objects) {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: fs.readFileSync(path.join(dir, file)),
          })
        );
      }
      console.log(`Imported ${index.objects.length} object(s)`);
    } else if (command === 'delete') {
      const [prefix, contains] = args;
      const keys = await listKeys(client, bucket, prefix, contains);
      for (const key of keys) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      }
      console.log(`Deleted ${keys.length} object(s)`);
    } else {
      throw new Error(
        'Usage: s3Objects.ts export <dir> <prefix> <contains> | import <dir> | delete <prefix> <contains>'
      );
    }
  } finally {
    client.destroy();
  }
}

await main(process.argv.slice(2));
