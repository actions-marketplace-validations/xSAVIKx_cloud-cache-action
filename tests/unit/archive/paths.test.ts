import { jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isWindows, makeTempDir, removeDir, setEnv, writeFiles } from '../../support/tempTree';

const mockWarning = jest.fn<(message: string) => void>();

jest.unstable_mockModule('@actions/core', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  isDebug: () => false,
  warning: mockWarning,
}));

const { preparePattern, resolveCachePaths } = await import('../../../src/archive/paths');

const itUnix = isWindows ? it.skip : it;
const itWindows = isWindows ? it : it.skip;
const toEntry = (from: string, to: string): string =>
  path.relative(from, to).split(path.sep).join('/');

describe('preparePattern', () => {
  it('anchors relative patterns at the escaped workspace', () => {
    expect(preparePattern('a/*.js', '/w[1]/x?', 'linux', '/home/u')).toBe('/w[[]1]/x[?]/a/*.js');
  });

  it('normalises absolute patterns, removing .. segments', () => {
    expect(preparePattern('/opt/tools/../cache/**', '/w', 'linux', '/home/u')).toBe(
      '/opt/cache/**'
    );
  });

  it('expands ~ to the escaped home directory', () => {
    expect(preparePattern('~/.npm', '/w', 'linux', '/home/u*')).toBe('/home/u[*]/.npm');
    expect(preparePattern('~', '/w', 'linux', '/home/u')).toBe('/home/u');
  });

  it('keeps a leading ! on exclusions', () => {
    expect(preparePattern(' !dist/*.map ', '/w', 'linux', '/home/u')).toBe('!/w/dist/*.map');
  });

  it('uses Windows separators and drive roots on win32', () => {
    expect(preparePattern('dist/*.js', 'D:\\a\\repo', 'win32', 'C:\\Users\\me')).toBe(
      'D:\\a\\repo\\dist\\*.js'
    );
    expect(preparePattern('~/.npm', 'D:\\a\\repo', 'win32', 'C:\\Users\\me')).toBe(
      'C:\\Users\\me\\.npm'
    );
    expect(preparePattern('C:/tools/../cache', 'D:\\a', 'win32', 'C:\\Users\\me')).toBe(
      'C:\\cache'
    );
  });
});

describe('resolveCachePaths', () => {
  let workspace: string;
  let outside: string;
  let home: string;
  let restoreEnv: () => void;

  const resolve = (patterns: string[]) => resolveCachePaths(patterns, workspace);

  beforeEach(() => {
    mockWarning.mockReset();
    workspace = makeTempDir('ws');
    outside = makeTempDir('outside');
    home = makeTempDir('home');
    restoreEnv = setEnv({ HOME: home, USERPROFILE: home });
  });

  afterEach(() => {
    restoreEnv();
    [workspace, outside, home].forEach(removeDir);
  });

  it('stores a relative file and directory as given', async () => {
    writeFiles(workspace, { 'a.txt': 'a', 'dir/b.txt': 'b' });
    await expect(resolve(['a.txt', 'dir'])).resolves.toEqual({
      entries: ['a.txt', 'dir'],
      skipped: [],
    });
  });

  it('resolves nested directories', async () => {
    writeFiles(workspace, { 'dir/sub/deep/file.txt': '' });
    expect((await resolve(['dir/sub/deep'])).entries).toEqual(['dir/sub/deep']);
  });

  it.each(['./dir', 'dir/', 'other/../dir', './other/../dir/'])(
    'normalises %s to the directory',
    async (pattern) => {
      writeFiles(workspace, { 'dir/b.txt': 'b', 'other/keep.txt': '' });
      expect((await resolve([pattern])).entries).toEqual(['dir']);
    }
  );

  it('stores an absolute path inside the workspace relative to it', async () => {
    writeFiles(workspace, { 'dir/b.txt': 'b' });
    expect((await resolve([path.join(workspace, 'dir')])).entries).toEqual(['dir']);
  });

  it('stores a path outside the workspace with ../ segments', async () => {
    writeFiles(outside, { 'tool/config.json': '{}' });
    const expected = toEntry(workspace, path.join(outside, 'tool'));
    expect(expected.startsWith('../')).toBe(true);
    expect((await resolve([path.join(outside, 'tool')])).entries).toEqual([expected]);
  });

  it('stores the workspace itself as . and drops everything it covers', async () => {
    writeFiles(workspace, { 'a.txt': 'a' });
    expect((await resolve([workspace, 'a.txt'])).entries).toEqual(['.']);
  });

  it.each(isWindows ? ['~/.npm-cache', '~\\.npm-cache'] : ['~/.npm-cache', '~/.npm-cache/'])(
    'expands %s to the home directory',
    async (pattern) => {
      writeFiles(home, { '.npm-cache/index.json': '{}' });
      expect((await resolve([pattern])).entries).toEqual([
        toEntry(workspace, path.join(home, '.npm-cache')),
      ]);
    }
  );

  it('expands a bare ~', async () => {
    expect((await resolve(['~'])).entries).toEqual([toEntry(workspace, home)]);
  });

  it('matches * and ? within one segment', async () => {
    writeFiles(workspace, { 'logs/a1.log': '', 'logs/b2.log': '', 'logs/c.txt': '' });
    expect((await resolve(['logs/*.log'])).entries).toEqual(['logs/a1.log', 'logs/b2.log']);
    expect((await resolve(['logs/?1.log'])).entries).toEqual(['logs/a1.log']);
  });

  it('matches character classes', async () => {
    writeFiles(workspace, { 'logs/a1.log': '', 'logs/b2.log': '', 'logs/c3.log': '' });
    expect((await resolve(['logs/[ab]*.log'])).entries).toEqual(['logs/a1.log', 'logs/b2.log']);
  });

  it('matches ** across directories, including several node_modules', async () => {
    writeFiles(workspace, {
      'node_modules/z/i.js': '',
      'packages/a/node_modules/x/i.js': '',
      'packages/b/node_modules/y/i.js': '',
    });
    expect((await resolve(['**/node_modules'])).entries).toEqual([
      'node_modules',
      'packages/a/node_modules',
      'packages/b/node_modules',
    ]);
  });

  it('removes paths matched by a later ! pattern, including hidden ones', async () => {
    writeFiles(workspace, {
      'packages/a/node_modules/dep/i.js': '',
      'packages/b/node_modules/dep/i.js': '',
      'packages/b/node_modules/.cache/secret.txt': '',
    });
    expect(
      (await resolve(['packages/*/node_modules/*', '!packages/b/node_modules/.cache'])).entries
    ).toEqual(['packages/a/node_modules/dep', 'packages/b/node_modules/dep']);
  });

  it('lets a later include win over an earlier exclusion', async () => {
    writeFiles(workspace, { 'logs/a1.log': '', 'logs/b2.log': '' });
    expect((await resolve(['!logs/a1.log', 'logs/*.log'])).entries).toEqual([
      'logs/a1.log',
      'logs/b2.log',
    ]);
  });

  it('archives a whole matched directory even when an exclusion names a file inside it', async () => {
    writeFiles(workspace, { 'logs/a1.log': '', 'logs/c.txt': '' });
    expect((await resolve(['logs', '!logs/c.txt'])).entries).toEqual(['logs']);
  });

  it('drops duplicates and entries inside an included directory', async () => {
    writeFiles(workspace, { 'dir/b.txt': 'b' });
    expect((await resolve(['dir', 'dir/b.txt', 'dir'])).entries).toEqual(['dir']);
  });

  it('keeps matches when other patterns match nothing', async () => {
    writeFiles(workspace, { 'a.txt': 'a' });
    expect((await resolve(['a.txt', 'missing/**', 'nope.txt'])).entries).toEqual(['a.txt']);
  });

  it('returns no entries when nothing matches', async () => {
    await expect(resolve(['missing'])).resolves.toEqual({ entries: [], skipped: [] });
  });

  it('keeps names with spaces, unicode and leading dashes', async () => {
    writeFiles(workspace, {
      'odd/with space.txt': '',
      'odd/ünïcödé.txt': '',
      'odd/-leading.txt': '',
      'odd/--checkpoint-action=exec=touch pwned': '',
      'odd/-C': '',
    });
    expect((await resolve(['odd/*'])).entries).toEqual([
      'odd/--checkpoint-action=exec=touch pwned',
      'odd/-C',
      'odd/-leading.txt',
      'odd/with space.txt',
      'odd/ünïcödé.txt',
    ]);
  });

  it('handles paths longer than 260 characters', async () => {
    const deep = Array.from({ length: 12 }, (_, i) => `segment-${i}-${'x'.repeat(20)}`).join('/');
    writeFiles(workspace, { [`${deep}/file.txt`]: '' });
    expect(path.join(workspace, deep).length).toBeGreaterThan(260);
    expect((await resolve([`${deep}/file.txt`])).entries).toEqual([`${deep}/file.txt`]);
  });

  itUnix('skips a name containing a line break, with a warning', async () => {
    writeFiles(workspace, { 'bad/line\nbreak.txt': '', 'bad/ok.txt': '' });
    const result = await resolve(['bad/*']);
    expect(result).toEqual({ entries: ['bad/ok.txt'], skipped: ['bad/line\nbreak.txt'] });
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('line breaks'));
  });

  itUnix('returns symlinks themselves without following them', async () => {
    writeFiles(workspace, { 'real/file.txt': 'x' });
    fs.symlinkSync('real', path.join(workspace, 'link-dir'));
    fs.symlinkSync(path.join(outside, 'nowhere'), path.join(workspace, 'dangling'));
    expect((await resolve(['link-dir', 'dangling'])).entries).toEqual(['dangling', 'link-dir']);
    expect((await resolve(['link-dir/*'])).entries).toEqual([]);
  });

  itWindows('matches case-insensitively on Windows', async () => {
    writeFiles(workspace, { 'Dir/File.txt': '' });
    expect((await resolve(['dir/file.TXT'])).entries).toEqual(['Dir/File.txt']);
  });

  itWindows('accepts backslash and absolute drive-letter patterns on Windows', async () => {
    writeFiles(workspace, { 'dir/b.txt': 'b' });
    expect((await resolve(['dir\\b.txt'])).entries).toEqual(['dir/b.txt']);
    expect((await resolve([`${workspace}\\dir`])).entries).toEqual(['dir']);
  });
});
