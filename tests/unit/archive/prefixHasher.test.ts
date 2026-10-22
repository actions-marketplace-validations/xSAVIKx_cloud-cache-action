import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256File } from '../../../src/archive/checksum';
import { createPrefixHasher } from '../../../src/archive/prefixHasher';
import { makeTempDir, removeDir } from '../../support/tempTree';

let tempDir: string;
let filePath: string;

beforeEach(() => {
  tempDir = makeTempDir('prefix-hasher-');
  filePath = path.join(tempDir, 'archive.bin');
});

afterEach(() => {
  removeDir(tempDir);
});

/** Distinct bytes, so a block hashed out of order or as zeros changes the digest. */
const randomData = (size: number): Buffer => crypto.randomBytes(size);

describe('createPrefixHasher', () => {
  it('hashes blocks written out of order once the prefix before them is on disk', async () => {
    const data = randomData(3 * 1024 * 1024 + 17);
    const a = 1024 * 1024;
    const b = 2 * 1024 * 1024 + 5;
    const handle = fs.openSync(filePath, 'w');
    fs.ftruncateSync(handle, data.length);
    const hasher = createPrefixHasher(filePath);
    try {
      fs.writeSync(handle, data, b, data.length - b, b);
      fs.writeSync(handle, data, 0, a, 0);
      hasher.advance(a);
      fs.writeSync(handle, data, a, b - a, a);
      fs.closeSync(handle);
      hasher.advance(data.length);
      const digest = await hasher.finish(data.length);
      expect(digest).toBe(await sha256File(filePath));
      expect(digest).toBe(crypto.createHash('sha256').update(data).digest('hex'));
    } finally {
      hasher.close();
    }
  });

  it('hashes the whole file on finish when advance was never called', async () => {
    const data = randomData(100_000);
    fs.writeFileSync(filePath, data);
    const hasher = createPrefixHasher(filePath);
    try {
      await expect(hasher.finish(data.length)).resolves.toBe(await sha256File(filePath));
    } finally {
      hasher.close();
    }
  });

  it('gives the digest of no bytes for an empty file', async () => {
    fs.writeFileSync(filePath, '');
    const hasher = createPrefixHasher(filePath);
    try {
      await expect(hasher.finish(0)).resolves.toBe(crypto.createHash('sha256').digest('hex'));
    } finally {
      hasher.close();
    }
  });

  it('throws at once when the file does not exist', () => {
    expect(() => createPrefixHasher(path.join(tempDir, 'missing.bin'))).toThrow(/ENOENT/);
  });

  it('rejects finish when the file is shorter than the size', async () => {
    fs.writeFileSync(filePath, randomData(10));
    const hasher = createPrefixHasher(filePath);
    try {
      await expect(hasher.finish(20)).rejects.toThrow(/ended after 10 of 20 bytes/);
    } finally {
      hasher.close();
    }
  });

  it('rejects finish after close, and close can be called twice', async () => {
    fs.writeFileSync(filePath, randomData(10));
    const hasher = createPrefixHasher(filePath);
    hasher.close();
    expect(() => hasher.close()).not.toThrow();
    await expect(hasher.finish(10)).rejects.toThrow(/closed/);
  });
});
