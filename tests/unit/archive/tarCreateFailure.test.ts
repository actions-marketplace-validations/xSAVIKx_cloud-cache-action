import { jest } from '@jest/globals';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeTempDir, removeDir } from '../../support/tempTree';

// createArchive spawns tar. The mock runs this Node script in place of tar, so each test controls
// what "tar" writes and how it exits.
let script = '';
const children: childProcess.ChildProcess[] = [];
const mockSpawn = jest.fn(
  (_tool: string, _args: string[], options: { stdio?: childProcess.StdioOptions }) => {
    const child = childProcess.spawn(process.execPath, ['-e', script], { stdio: options.stdio });
    children.push(child);
    return child;
  }
);

jest.unstable_mockModule('node:child_process', () => ({ ...childProcess, spawn: mockSpawn }));

const { createArchive } = await import('../../../src/archive/tar');

const gzip = { method: 'gzip', archiveFilename: 'cache.tar.gz' } as const;

describe('createArchive failures', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir('tar-create-failure');
    children.length = 0;
  });

  afterEach(() => removeDir(dir));

  it('rejects with the exit code and the stderr tail, and removes the partial archive', async () => {
    script =
      "process.stdout.write('partial'); process.stderr.write('tar: data: Cannot stat\\n'); process.exitCode = 2;";
    const archivePath = path.join(dir, 'out', gzip.archiveFilename);

    await expect(createArchive(archivePath, ['data'], gzip, dir)).rejects.toThrow(
      /^The process '.+' failed with exit code 2\ntar: data: Cannot stat$/
    );
    expect(fs.existsSync(archivePath)).toBe(false);
  });

  const onLinux = process.platform === 'linux' ? it : it.skip;

  // /dev/full fails every write with ENOSPC, like a full disk.
  onLinux(
    'stops tar and rejects when the archive file cannot be written',
    async () => {
      script = 'setInterval(() => process.stdout.write(Buffer.alloc(65536)), 1);';

      await expect(createArchive('/dev/full', ['data'], gzip, dir)).rejects.toThrow(/ENOSPC/);
      expect(children).toHaveLength(1);
      expect(children[0].exitCode !== null || children[0].signalCode !== null).toBe(true);
    },
    10_000
  );
});
