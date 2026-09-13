import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { Transform } from 'node:stream';

/** Hashes a file on disk with sha256, streaming it chunk by chunk. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export interface Sha256Tap {
  /** A pass-through Transform: whatever is written comes out unchanged. */
  stream: Transform;
  /** The hex digest of everything that has passed through so far. Call once, after 'end'. */
  digest(): string;
}

/** A sha256 tap for streaming pipelines (used by Task 8): hashes data as it flows through. */
export function createSha256Tap(): Sha256Tap {
  const hash = crypto.createHash('sha256');
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return {
    stream,
    digest: () => hash.digest('hex'),
  };
}
