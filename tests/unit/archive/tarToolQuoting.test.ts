import { jest } from '@jest/globals';
import * as path from 'node:path';
import { makeTempDir, removeDir } from '../../support/tempTree';

type Exec = (
  commandLine: string,
  args?: string[],
  options?: { env?: Record<string, string> }
) => Promise<number>;
type Which = (tool: string, check?: boolean) => Promise<string>;

const mockExec = jest.fn<Exec>();
const mockWhich = jest.fn<Which>();

jest.unstable_mockModule('@actions/exec', () => ({ exec: mockExec }));
jest.unstable_mockModule('@actions/io', () => ({ which: mockWhich }));

const { createArchive, extractArchive } = await import('../../../src/archive/tar');

// exec.exec parses its first argument as a command line, so a tool path with spaces (as
// produced by findTar for Git's bundled tar.exe on Windows) must be quoted, while the
// remaining arguments are passed through as an array, unquoted and unchanged.
const TOOL_WITH_SPACES = 'C:\\Program Files\\Git\\usr\\bin\\tar.exe';

describe('tool paths containing spaces', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir('tar-quoting');
    mockExec.mockReset();
    mockExec.mockResolvedValue(0);
    mockWhich.mockReset();
    mockWhich.mockResolvedValue(TOOL_WITH_SPACES);
  });

  afterEach(() => removeDir(dir));

  it('quotes the tool as the exec command line and leaves the archive-create arguments unchanged', async () => {
    const compression = { method: 'gzip', archiveFilename: 'cache.tar.gz' } as const;
    const archivePath = path.join(dir, 'out', compression.archiveFilename);

    await createArchive(archivePath, ['data'], compression, dir);

    expect(mockExec).toHaveBeenCalledTimes(1);
    const [commandLine, args] = mockExec.mock.calls[0];
    expect(commandLine).toBe(`"${TOOL_WITH_SPACES}"`);
    expect(Array.isArray(args)).toBe(true);
    for (const arg of args ?? []) {
      expect(arg.startsWith('"') && arg.endsWith('"')).toBe(false);
    }
    expect(args).toEqual(expect.arrayContaining(['-cf', '-P', '-C', '-z']));
  });

  it('quotes the tool as the exec command line and leaves the archive-extract arguments unchanged', async () => {
    const compression = { method: 'gzip', archiveFilename: 'cache.tar.gz' } as const;
    const archivePath = path.join(dir, compression.archiveFilename);

    await extractArchive(archivePath, compression, dir);

    expect(mockExec).toHaveBeenCalledTimes(1);
    const [commandLine, args] = mockExec.mock.calls[0];
    expect(commandLine).toBe(`"${TOOL_WITH_SPACES}"`);
    expect(Array.isArray(args)).toBe(true);
    for (const arg of args ?? []) {
      expect(arg.startsWith('"') && arg.endsWith('"')).toBe(false);
    }
    expect(args).toEqual(['-xf', archivePath, '-P', '-C', dir, '-z']);
  });
});
