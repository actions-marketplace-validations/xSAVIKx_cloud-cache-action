import * as io from '@actions/io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { CompressionConfig } from '../../../src/archive/compression';
import { resolveCachePaths } from '../../../src/archive/paths';
import { captureStderrTail, spawnArchiveCommand, waitForExit } from '../../../src/archive/stream';
import {
  buildCreateCommands,
  buildExtractCommands,
  findTar,
  formatManifest,
} from '../../../src/archive/tar';
import {
  buildFixtureTree,
  clearFixtureRoots,
  verifyFixtureTree,
  type FixtureRoots,
} from '../../support/fixtureTree';
import { makeTempDir, removeDir, setEnv } from '../../support/tempTree';

// The real streaming round trip (Task 8): unlike roundTrip.test.ts, this never writes a
// temporary archive file that tar itself manages. tar's stdout is piped straight to a plain
// file write stream to stand in for the S3 upload body, and a plain file read stream is piped
// straight into tar's stdin to stand in for the S3 download body.

async function streamCreate(
  entries: readonly string[],
  compression: CompressionConfig,
  workspace: string,
  destinationPath: string
): Promise<void> {
  const tar = await findTar();
  const tempDir = makeTempDir('stream-create');
  try {
    const manifestPath = path.join(tempDir, 'manifest.txt');
    fs.writeFileSync(manifestPath, formatManifest(entries));
    const [command] = buildCreateCommands({
      tar,
      platform: process.platform,
      compression: compression.method,
      archivePath: '-',
      workspace,
      tempDir,
      manifestPath,
    });

    const child = spawnArchiveCommand(command, ['ignore', 'pipe', 'pipe']);
    const stderrTail = captureStderrTail(child.stderr);
    const destination = fs.createWriteStream(destinationPath);
    const piped = pipeline(child.stdout as NodeJS.ReadableStream, destination);
    const [, code] = await Promise.all([piped, waitForExit(child)]);
    if (code !== 0) {
      throw new Error(`tar exited with code ${code}: ${stderrTail.lines().join('\n')}`);
    }
  } finally {
    removeDir(tempDir);
  }
}

async function streamExtract(
  compression: CompressionConfig,
  workspace: string,
  archivePath: string
): Promise<void> {
  const tar = await findTar();
  fs.mkdirSync(workspace, { recursive: true });
  const [command] = buildExtractCommands({
    tar,
    platform: process.platform,
    compression: compression.method,
    archivePath: '-',
    workspace,
    tempDir: workspace,
  });

  const child = spawnArchiveCommand(command, ['pipe', 'ignore', 'pipe']);
  const stderrTail = captureStderrTail(child.stderr);
  const source = fs.createReadStream(archivePath);
  const piped = pipeline(source, child.stdin as NodeJS.WritableStream);
  const [, code] = await Promise.all([piped, waitForExit(child)]);
  if (code !== 0) {
    throw new Error(`tar exited with code ${code}: ${stderrTail.lines().join('\n')}`);
  }
}

const compressions: CompressionConfig[] = [
  { method: 'gzip', archiveFilename: 'cache.tar.gz' },
  { method: 'zstd', archiveFilename: 'cache.tar.zst' },
];

describe.each(compressions)('streaming tar round trip with $method', (compression) => {
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

  it('streams create to a file and streams extract from it, restoring every fixture case exactly', async () => {
    if (compression.method === 'zstd' && !(await io.which('zstd', false))) {
      console.log('zstd is not installed on this machine; skipping the zstd streaming round trip.');
      return;
    }

    const fixture = buildFixtureTree(roots, { largeFileBytes: 4 * 1024 * 1024 });
    const { entries } = await resolveCachePaths(fixture.patterns, roots.workspace);
    const archive = path.join(scratch, compression.archiveFilename);

    await streamCreate(entries, compression, roots.workspace, archive);
    expect(fs.existsSync(archive)).toBe(true);
    expect(fs.statSync(archive).size).toBeGreaterThan(0);

    clearFixtureRoots(roots);
    expect(verifyFixtureTree(fixture, roots)).not.toEqual([]);

    await streamExtract(compression, roots.workspace, archive);
    expect(verifyFixtureTree(fixture, roots)).toEqual([]);
  }, 120_000);
});
