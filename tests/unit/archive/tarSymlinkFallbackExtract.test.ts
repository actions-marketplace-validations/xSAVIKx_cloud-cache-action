import { jest } from '@jest/globals';
import * as actualFs from 'node:fs';
import * as path from 'node:path';
import { makeTempDir, removeDir } from '../../support/tempTree';

type ExecOptions = {
  env?: Record<string, string>;
  listeners?: { stderr?: (data: Buffer) => void };
};
type Exec = (commandLine: string, args?: string[], options?: ExecOptions) => Promise<number>;

const mockExec = jest.fn<Exec>();
const mockWarning = jest.fn<(message: string) => void>();
const GIT_TAR = 'C:\\Program Files\\Git\\usr\\bin\\tar.exe';

jest.unstable_mockModule('@actions/exec', () => ({ exec: mockExec }));
jest.unstable_mockModule('@actions/core', () => ({ warning: mockWarning }));
// findTar on win32 looks for Git's tar with existsSync. Every other fs call is the real one.
jest.unstable_mockModule('node:fs', () => {
  const existsSync = (file: actualFs.PathLike): boolean =>
    file === GIT_TAR || actualFs.existsSync(file);
  return { ...actualFs, default: { ...actualFs, existsSync }, existsSync };
});

const { extractArchive } = await import('../../../src/archive/tar');

describe('extractArchive on Windows with Git tar', () => {
  let dir: string;
  let restoreEnv: NodeJS.ProcessEnv;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

  beforeEach(() => {
    dir = makeTempDir('tar-symlink-fallback');
    restoreEnv = { ...process.env };
    process.env.ProgramFiles = 'C:\\Program Files';
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    mockExec.mockReset();
    mockWarning.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    process.env = restoreEnv;
    removeDir(dir);
  });

  it('extracts again with copied symlinks after a symlink permission failure', async () => {
    mockExec
      .mockImplementationOnce(async (commandLine, _args, options) => {
        options?.listeners?.stderr?.(
          Buffer.from(
            "tar: a: Cannot create symlink to 'b': Operation not permitted\n" +
              'tar: Exiting with failure status due to previous errors\n'
          )
        );
        throw new Error(`The process '${commandLine}' failed with exit code 2`);
      })
      .mockResolvedValueOnce(0);

    const compression = { method: 'zstd' as const, archiveFilename: 'cache.tzst' };
    await extractArchive(path.join(dir, 'cache.tzst'), compression, path.join(dir, 'ws'));

    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec.mock.calls[0][0]).toBe(`"${GIT_TAR}"`);
    expect(mockExec.mock.calls[0][2]?.env?.MSYS).toBe('winsymlinks:nativestrict');
    expect(mockExec.mock.calls[1][0]).toBe(`"${GIT_TAR}"`);
    expect(mockExec.mock.calls[1][2]?.env?.MSYS).toBe('winsymlinks:deepcopy');
    expect(mockWarning).toHaveBeenCalledTimes(1);
  });
});
