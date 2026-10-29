import { jest } from '@jest/globals';
import * as realExec from '@actions/exec';
import * as realIo from '@actions/io';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256File } from '../../../src/archive/checksum';
import { makeTempDir, removeDir, writeFiles } from '../../support/tempTree';

// The test makes findTar pick BSD tar: the platform is darwin and gtar is absent. The "BSD" tool
// is the real tar of this machine, which accepts the BSD create arguments. exec and spawn are
// recorded and then run for real.
const realTar = await realIo.which('tar', false);
const mockExec = jest.fn(realExec.exec);
const mockSpawn = jest.fn(childProcess.spawn);

jest.unstable_mockModule('@actions/exec', () => ({ ...realExec, exec: mockExec }));
jest.unstable_mockModule('@actions/io', () => ({
  ...realIo,
  which: async (tool: string) => (tool === 'tar' ? realTar : ''),
}));
jest.unstable_mockModule('node:child_process', () => ({ ...childProcess, spawn: mockSpawn }));

const { createArchive } = await import('../../../src/archive/tar');

// Windows runners have no tar on PATH that accepts these arguments in every case.
const describeOffWindows = process.platform === 'win32' || !realTar ? describe.skip : describe;

describeOffWindows('createArchive with BSD tar', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir('tar-create-bsd');
    writeFiles(dir, { 'data/a.txt': 'alpha', 'data/b.txt': 'beta' });
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform);
    }
    removeDir(dir);
  });

  it('writes the archive file, not stdout, and hashes the file', async () => {
    const compression = { method: 'gzip', archiveFilename: 'cache.tar.gz' } as const;
    const archivePath = path.join(dir, 'out', compression.archiveFilename);

    const { sha256 } = await createArchive(archivePath, ['data'], compression, dir);

    expect(mockSpawn.mock.calls.filter(([tool]) => tool === realTar)).toEqual([]);
    expect(mockExec).toHaveBeenCalledTimes(1);
    const [, args] = mockExec.mock.calls[0];
    expect(args).not.toContain('-');
    expect(args?.slice(0, 2)).toEqual(['-cf', archivePath.replace(/\\/g, '/')]);
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(sha256).toBe(await sha256File(archivePath));
  });
});
