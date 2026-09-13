import * as io from '@actions/io';
import * as path from 'node:path';
import type { CompressionConfig } from '../../../src/archive/compression';
import { resolveCachePaths } from '../../../src/archive/paths';
import { createArchive, extractArchive } from '../../../src/archive/tar';
import {
  buildFixtureTree,
  clearFixtureRoots,
  verifyFixtureTree,
  type FixtureRoots,
} from '../../support/fixtureTree';
import { makeTempDir, removeDir, setEnv } from '../../support/tempTree';

const compressions: CompressionConfig[] = [
  { method: 'gzip', archiveFilename: 'cache.tar.gz' },
  { method: 'zstd', archiveFilename: 'cache.tar.zst' },
];

describe.each(compressions)('tar round trip with $method', (compression) => {
  let roots: FixtureRoots;
  let scratch: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    roots = {
      workspace: makeTempDir('ws'),
      outside: makeTempDir('outside'),
      home: makeTempDir('home'),
    };
    scratch = makeTempDir('archive');
    restoreEnv = setEnv({ HOME: roots.home, USERPROFILE: roots.home });
  });

  afterEach(() => {
    restoreEnv();
    [roots.workspace, roots.outside, roots.home, scratch].forEach(removeDir);
  });

  it('restores every fixture case exactly, including paths outside the workspace', async () => {
    if (compression.method === 'zstd' && !(await io.which('zstd', false))) {
      console.log('zstd is not installed on this machine; skipping the zstd round trip.');
      return;
    }

    const fixture = buildFixtureTree(roots, { largeFileBytes: 8 * 1024 * 1024 });
    const { entries } = await resolveCachePaths(fixture.patterns, roots.workspace);
    const archive = path.join(scratch, compression.archiveFilename);

    await createArchive(archive, entries, compression, roots.workspace);
    clearFixtureRoots(roots);
    expect(verifyFixtureTree(fixture, roots)).not.toEqual([]);

    await extractArchive(archive, compression, roots.workspace);
    expect(verifyFixtureTree(fixture, roots)).toEqual([]);
  }, 120_000);
});
