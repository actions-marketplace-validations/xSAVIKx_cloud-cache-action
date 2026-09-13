import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import * as core from '@actions/core';

export interface CacheObjectMetadata {
  key: string;
  size: number;
  lastModified?: Date;
  etag?: string;
}

export async function checkObjectExists(
  client: S3Client,
  bucket: string,
  key: string
): Promise<CacheObjectMetadata | null> {
  try {
    const cmd = new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    const response = await client.send(cmd);
    return {
      key,
      size: response.ContentLength || 0,
      lastModified: response.LastModified,
      etag: response.ETag,
    };
  } catch (err: unknown) {
    const error = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      error.name === 'NotFound' ||
      error.name === 'NoSuchKey' ||
      error.$metadata?.httpStatusCode === 404
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Lists every object under `prefix`, following continuation tokens, and returns the most
 * recently modified one that `accept` allows. When timestamps tie, the first object listed wins.
 */
export async function findNewestObject(
  client: S3Client,
  bucket: string,
  prefix: string,
  accept: (key: string) => boolean,
  pageSize = 1000
): Promise<CacheObjectMetadata | undefined> {
  let newest: CacheObjectMetadata | undefined;
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: pageSize,
        ContinuationToken: continuationToken,
      })
    );
    for (const object of page.Contents ?? []) {
      if (!object.Key || !accept(object.Key)) {
        continue;
      }
      const modified = object.LastModified?.getTime() ?? 0;
      if (!newest || modified > (newest.lastModified?.getTime() ?? 0)) {
        newest = {
          key: object.Key,
          size: object.Size ?? 0,
          lastModified: object.LastModified,
          etag: object.ETag,
        };
      }
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return newest;
}

export async function downloadFile(
  client: S3Client,
  bucket: string,
  key: string,
  destinationPath: string
): Promise<void> {
  // Ensure target folder exists
  const dir = path.dirname(destinationPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  const response = await client.send(cmd);
  if (!response.Body) {
    throw new Error(`Empty response body received from S3 for key: ${key}`);
  }

  const fileStream = fs.createWriteStream(destinationPath);
  await pipeline(response.Body as Readable, fileStream);
}

export async function uploadFile(
  client: S3Client,
  bucket: string,
  key: string,
  sourcePath: string,
  uploadChunkSize?: number
): Promise<{ size: number; etag?: string }> {
  const stats = fs.statSync(sourcePath);
  const fileStream = fs.createReadStream(sourcePath);

  // S3 parts must be at least 5 MiB; a smaller or unset chunk size uses 10 MiB parts.
  const partSize =
    uploadChunkSize && uploadChunkSize >= 5 * 1024 * 1024 ? uploadChunkSize : 10 * 1024 * 1024;

  const parallelUpload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: fileStream,
    },
    partSize,
    queueSize: 4,
    leavePartsOnError: false,
  });

  parallelUpload.on('httpUploadProgress', (progress) => {
    if (progress.total && progress.loaded) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      core.debug(`Upload progress: ${pct}% (${progress.loaded}/${progress.total} bytes)`);
    }
  });

  const result = await parallelUpload.done();

  return {
    size: stats.size,
    etag: result.ETag,
  };
}
