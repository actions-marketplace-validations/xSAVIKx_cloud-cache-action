import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createSha256Tap, sha256File } from '../../../src/archive/checksum';

describe('sha256File', () => {
  it('matches the known sha256("abc") vector', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksum-'));
    const filePath = path.join(tempDir, 'abc.txt');
    fs.writeFileSync(filePath, 'abc');
    try {
      await expect(sha256File(filePath)).resolves.toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('hashes a large file without buffering it whole', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksum-'));
    const filePath = path.join(tempDir, 'large.bin');
    // Larger than a single default highWaterMark chunk, to exercise multi-chunk streaming.
    const data = Buffer.alloc(5 * 1024 * 1024, 7);
    fs.writeFileSync(filePath, data);
    try {
      const expected = crypto.createHash('sha256').update(data).digest('hex');
      await expect(sha256File(filePath)).resolves.toBe(expected);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('createSha256Tap', () => {
  it('passes bytes through unchanged while computing their sha256', async () => {
    const tap = createSha256Tap();
    const data = Buffer.from('the quick brown fox jumps over the lazy dog');
    const expected = crypto.createHash('sha256').update(data).digest('hex');

    const chunks: Buffer[] = [];
    tap.stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    tap.stream.end(data);
    await new Promise((resolve) => tap.stream.on('end', resolve));

    expect(Buffer.concat(chunks)).toEqual(data);
    expect(tap.digest()).toBe(expected);
  });

  it('can sit in a pipeline between a source and a destination stream', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksum-tap-'));
    const source = path.join(tempDir, 'source.bin');
    const destination = path.join(tempDir, 'destination.bin');
    const data = Buffer.alloc(64 * 1024, 3);
    fs.writeFileSync(source, data);

    try {
      const tap = createSha256Tap();
      await pipeline(fs.createReadStream(source), tap.stream, fs.createWriteStream(destination));

      const expected = crypto.createHash('sha256').update(data).digest('hex');
      expect(tap.digest()).toBe(expected);
      expect(fs.readFileSync(destination)).toEqual(data);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
