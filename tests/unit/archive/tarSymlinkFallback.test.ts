import { jest } from '@jest/globals';
import type { ArchivePlan, TarTool } from '../../../src/archive/tar';

type ExecOptions = {
  env?: Record<string, string>;
  listeners?: { stderr?: (data: Buffer) => void };
};
type Exec = (commandLine: string, args?: string[], options?: ExecOptions) => Promise<number>;

const mockExec = jest.fn<Exec>();
const mockWarning = jest.fn<(message: string) => void>();

jest.unstable_mockModule('@actions/exec', () => ({ exec: mockExec }));
jest.unstable_mockModule('@actions/core', () => ({ warning: mockWarning }));

const { isSymlinkPermissionError, runExtract, usesSymlinkFallback } = await import(
  '../../../src/archive/tar'
);

const gitTar: TarTool = { path: 'C:\\Program Files\\Git\\usr\\bin\\tar.exe', flavor: 'gnu' };
const systemTar: TarTool = { path: 'C:\\Windows\\System32\\tar.exe', flavor: 'bsd' };
const linuxTar: TarTool = { path: '/usr/bin/tar', flavor: 'gnu' };

const winPlan: ArchivePlan = {
  tar: gitTar,
  platform: 'win32',
  compression: 'zstd',
  archivePath: 'D:\\a\\_temp\\r\\cache.tzst',
  workspace: 'D:\\a\\app\\app',
  tempDir: 'D:\\a\\_temp\\t',
};

// GNU tar 1.35 prints "%s: Cannot create symlink to %s" and appends strerror(EPERM). The MSYS
// runtime maps ERROR_PRIVILEGE_NOT_HELD to EPERM, "Operation not permitted".
const SYMLINK_EPERM = [
  "tar: node_modules/.bin/jest: Cannot create symlink to '../jest/bin/jest.js': Operation not permitted",
  "tar: lib/current: Cannot create symlink to 'v2': Operation not permitted",
  'tar: Exiting with failure status due to previous errors',
  '',
].join('\n');

function failWith(stderr: string, code = 2): Exec {
  return async (commandLine, _args, options) => {
    options?.listeners?.stderr?.(Buffer.from(stderr));
    throw new Error(`The process '${commandLine}' failed with exit code ${code}`);
  };
}

describe('isSymlinkPermissionError', () => {
  it('matches GNU tar symlink errors with EPERM', () => {
    expect(isSymlinkPermissionError(SYMLINK_EPERM)).toBe(true);
  });

  it('matches CRLF line ends and curly quotes', () => {
    expect(
      isSymlinkPermissionError(
        'tar: a/b: Cannot create symlink to \u2018c\u2019: Operation not permitted\r\n' +
          'tar: Exiting with failure status due to previous errors\r\n'
      )
    ).toBe(true);
  });

  it.each([
    ['empty stderr', ''],
    ['only the summary line', 'tar: Exiting with failure status due to previous errors\n'],
    [
      'a symlink error with another errno',
      "tar: a: Cannot create symlink to 'b': No such file or directory\n",
    ],
    ['EPERM on a regular file', 'tar: a.txt: Cannot open: Operation not permitted\n'],
    [
      'a symlink EPERM together with another error',
      "tar: a: Cannot create symlink to 'b': Operation not permitted\n" +
        'tar: c.txt: Cannot write: No space left on device\n',
    ],
    [
      'a symlink EPERM together with a zstd error',
      "tar: a: Cannot create symlink to 'b': Operation not permitted\n" +
        '/*stdin*\\ : Decoding error (36) : Corrupted block detected\n',
    ],
  ])('does not match %s', (_name, stderr) => {
    expect(isSymlinkPermissionError(stderr)).toBe(false);
  });
});

describe('usesSymlinkFallback', () => {
  it.each<[string, TarTool, NodeJS.Platform, boolean]>([
    ["Git's GNU tar on Windows", gitTar, 'win32', true],
    ['BSD tar on Windows, which ignores MSYS', systemTar, 'win32', false],
    ['GNU tar on Linux', linuxTar, 'linux', false],
  ])('%s: %s', (_name, tar, platform, expected) => {
    expect(usesSymlinkFallback({ tar, platform })).toBe(expected);
  });
});

describe('runExtract', () => {
  beforeEach(() => {
    mockExec.mockReset();
    mockWarning.mockReset();
  });

  it('runs once with native symlinks when the extract succeeds', async () => {
    mockExec.mockResolvedValue(0);
    await runExtract(winPlan, { PATH: 'C:\\bin' });

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec.mock.calls[0][2]?.env).toEqual({
      PATH: 'C:\\bin',
      MSYS: 'winsymlinks:nativestrict',
    });
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it('retries once with copied symlinks after a symlink permission failure', async () => {
    mockExec.mockImplementationOnce(failWith(SYMLINK_EPERM)).mockResolvedValueOnce(0);
    await runExtract(winPlan, { PATH: 'C:\\bin', MSYS: 'winsymlinks:lnk' });

    expect(mockExec).toHaveBeenCalledTimes(2);
    const [first, second] = mockExec.mock.calls;
    expect(first[2]?.env?.MSYS).toBe('winsymlinks:nativestrict');
    expect(second[2]?.env).toEqual({ PATH: 'C:\\bin', MSYS: 'winsymlinks:deepcopy' });
    // The retry runs the same command with the same arguments.
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toEqual(first[1]);
    expect(mockWarning).toHaveBeenCalledTimes(1);
    expect(mockWarning.mock.calls[0][0]).toMatch(/SeCreateSymbolicLinkPrivilege/);
    expect(mockWarning.mock.calls[0][0]).toMatch(/as copies/);
  });

  it('collects stderr that arrives in several chunks', async () => {
    mockExec
      .mockImplementationOnce(async (commandLine, _args, options) => {
        const bytes = Buffer.from(SYMLINK_EPERM);
        for (let i = 0; i < bytes.length; i += 7) {
          options?.listeners?.stderr?.(bytes.subarray(i, i + 7));
        }
        throw new Error(`The process '${commandLine}' failed with exit code 2`);
      })
      .mockResolvedValueOnce(0);
    await runExtract(winPlan, {});

    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it('does not retry more than once', async () => {
    mockExec.mockImplementation(failWith(SYMLINK_EPERM));

    await expect(runExtract(winPlan, {})).rejects.toThrow(/exit code 2/);
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it('reports the retry failure', async () => {
    mockExec
      .mockImplementationOnce(failWith(SYMLINK_EPERM))
      .mockImplementationOnce(
        failWith("tar: a: Cannot create symlink to 'b': No such file or directory\n", 3)
      );

    await expect(runExtract(winPlan, {})).rejects.toThrow(/exit code 3/);
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['another tar error', 'tar: a.txt: Cannot write: No space left on device\n'],
    ['a corrupt archive', '/*stdin*\\ : Decoding error (36) : Corrupted block detected\n'],
    ['no stderr', ''],
  ])('does not retry after %s', async (_name, stderr) => {
    mockExec.mockImplementation(failWith(stderr));

    await expect(runExtract(winPlan, {})).rejects.toThrow(/exit code 2/);
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<ArchivePlan>]>([
    ['BSD tar on Windows', { tar: systemTar }],
    ['GNU tar on Linux', { tar: linuxTar, platform: 'linux' }],
  ])('does not retry with %s', async (_name, change) => {
    mockExec.mockImplementation(failWith(SYMLINK_EPERM));

    await expect(runExtract({ ...winPlan, ...change }, {})).rejects.toThrow();
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockWarning).not.toHaveBeenCalled();
  });
});
