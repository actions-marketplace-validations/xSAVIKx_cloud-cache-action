import { jest } from '@jest/globals';
import * as path from 'node:path';
import { makeTempDir, removeDir } from '../../support/tempTree';

type Exec = (
  commandLine: string,
  args?: string[],
  options?: { env?: Record<string, string> }
) => Promise<number>;

const mockExec = jest.fn<Exec>();

jest.unstable_mockModule('@actions/exec', () => ({ exec: mockExec }));

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
  });

  afterEach(() => removeDir(dir));

  it.each(['gzip', 'zstd'] as const)(
    'runs every %s create and extract command with MSYS set',
    async (method) => {
      const compression = { method, archiveFilename: `cache.${method}` };
      const archivePath = path.join(dir, 'out', compression.archiveFilename);
      await createArchive(archivePath, ['data'], compression, dir);
      await extractArchive(archivePath, compression, dir);

      expect(mockExec.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const [, , options] of mockExec.mock.calls) {
        expect(options?.env).toMatchObject({ MSYS: 'winsymlinks:nativestrict' });
        expect(options?.env?.PATH ?? options?.env?.Path).toBe(process.env.PATH ?? process.env.Path);
      }
    }
  );
});
