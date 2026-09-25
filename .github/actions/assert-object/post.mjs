import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

const input = (name) => process.env[`INPUT_${name.toUpperCase()}`] ?? '';
const bucket = process.env.TEST_S3_BUCKET || 'cloud-cache-test';
const prefix = `${process.env.GITHUB_REPOSITORY}/${encodeURIComponent(input('ref'))}/${input('key')}/`;

const client = new S3Client({
  endpoint: process.env.TEST_S3_ENDPOINT || 'http://127.0.0.1:8333',
  region: process.env.TEST_S3_REGION || 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.TEST_S3_ACCESS_KEY || 'cloudcacheci',
    secretAccessKey: process.env.TEST_S3_SECRET_KEY || 'cloudcachecisecret',
  },
});

const page = await client.send(
  new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 })
);
const found = page.Contents?.[0]?.Key;
if (!found) {
  console.log(
    `::error::No cache object under s3://${bucket}/${prefix}; the post-step save did not happen.`
  );
  process.exit(1);
}
console.log(`Post-step save verified: s3://${bucket}/${found}`);
