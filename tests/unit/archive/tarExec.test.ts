import { jest } from '@jest/globals';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import { makeTempDir, removeDir } from '../../support/tempTree';

type Exec = (
  commandLine: string,
  args?: string[],
  options?: { env?: Record<string, string> }
) => Promise<number>;

type SpawnOptions = { env?: NodeJS.ProcessEnv; stdio?: childProcess.StdioOptions };

const mockExec = jest.fn<Exec>();
// createArchive spawns tar without exec. The mock records the options and runs an empty Node
// script in place of tar, so the test needs no tar.
const mockSpawn = jest.fn((_tool: string, _args: string[], options: SpawnOptions) =>
  childProcess.spawn(process.execPath, ['-e', ''], { stdio: options.stdio })
);

jest.unstable_mockModule('@actions/exec', () => ({ exec: mockExec }));
jest.unstable_mockModule('node:child_process', () => ({ ...childProcess, spawn: mockSpawn }));

const { archiveExecOptions, createArchive, extractArchive } = await import(
  '../../../src/archive/tar'
);

describe('archiveExecOptions', () => {
  it('keeps the environment and asks MSYS tar for native symlinks, like actions/cache', () => {
    expect(archiveExecOptions({ PATH: '/bin', UNSET: undefined })).toEqual({
      env: { PATH: '/bin', MSYS: 'winsymlinks:nativestrict' },
    });
  });

  it('overrides an MSYS value that is already set', () => {
    expect(archiveExecOptions({ MSYS: 'winsymlinks:lnk' }).env?.MSYS).toBe(
      'winsymlinks:nativestrict'
    );
  });
});

describe('archive commands', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir('tar-exec');
    mockExec.mockReset();
    mockExec.mockResolvedValue(0);
    mockSpawn.mockClear();
  });

  afterEach(() => removeDir(dir));

  it.each(['gzip', 'zstd'] as const)(
    'runs every %s create and extract command with MSYS set',
    async (method) => {
      const compression = { method, archiveFilename: `cache.${method}` };
      const archivePath = path.join(dir, 'out', compression.archiveFilename);
      await createArchive(archivePath, ['data'], compression, dir);
      await extractArchive(archivePath, compression, dir);

      const envs = [
        ...mockExec.mock.calls.map(([, , options]) => options?.env),
        ...mockSpawn.mock.calls.map(([, , options]) => options.env),
      ];
      expect(envs.length).toBeGreaterThanOrEqual(2);
      for (const env of envs) {
        expect(env).toMatchObject({ MSYS: 'winsymlinks:nativestrict' });
        expect(env?.PATH ?? env?.Path).toBe(process.env.PATH ?? process.env.Path);
      }
    }
  );
});
