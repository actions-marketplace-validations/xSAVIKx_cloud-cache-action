/**
 * Builds, clears and verifies a directory tree that exercises every path case the action must
 * round-trip. Used by Jest and, through its CLI, by the CI workflows:
 *
 *   node tests/support/fixtureTree.ts build <manifest.json> [--portable] [--large-bytes N]
 *   node tests/support/fixtureTree.ts clear
 *   node tests/support/fixtureTree.ts verify <manifest.json>
 *   node tests/support/fixtureTree.ts paths <manifest.json>
 *
 * Roots come from FIXTURE_WORKSPACE (default GITHUB_WORKSPACE, then cwd), FIXTURE_OUTSIDE
 * (default $RUNNER_TEMP/cloud-cache-outside) and FIXTURE_HOME (default the home directory).
 * Only fixture-owned paths are ever created or removed under those roots.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface FixtureRoots {
  workspace: string;
  outside: string;
  home: string;
}

export type RootName = keyof FixtureRoots;

export interface FixtureEntry {
  root: RootName;
  path: string;
  type: 'file' | 'dir' | 'symlink';
  sha256?: string;
  target?: string;
  executable?: boolean;
}

export interface FixtureManifest {
  patterns: string[];
  entries: FixtureEntry[];
  absent: Array<{ root: RootName; path: string }>;
}

export interface FixtureOptions {
  /** Omit what cannot move between operating systems: symlinks and paths outside the workspace. */
  portable?: boolean;
  largeFileBytes?: number;
}

const WORKSPACE_DIR = 'cache-fixture';
const OUTSIDE_DIR = 'tool';
const HOME_DIR = '.cloud-cache-fixture';
const isWindows = process.platform === 'win32';
/** Executable bits only mean something on POSIX filesystems; Windows has no equivalent. */
const supportsExecutableBit = !isWindows;

/**
 * Normalises a symlink target for comparison across platforms. Windows can report a restored
 * symlink's target with `\` separators even when it was created with `/`, so verification
 * compares targets after folding both to `/`.
 */
export function normalizeLinkTarget(target: string): string {
  return target.replace(/\\/g, '/');
}

const sha256 = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex');

/** Incompressible but reproducible bytes, so the large file forces a multipart upload. */
function deterministicBytes(size: number): Buffer {
  const out = Buffer.alloc(size);
  let block = createHash('sha256').update('cloud-cache-fixture').digest();
  for (let offset = 0; offset < size; offset += block.length) {
    block.copy(out, offset);
    block = createHash('sha256').update(block).digest();
  }
  return out;
}

const resolveIn = (roots: FixtureRoots, root: RootName, relative: string): string =>
  path.join(roots[root], ...relative.split('/'));

export function rootsFromEnv(env: NodeJS.ProcessEnv): FixtureRoots {
  return {
    workspace: env.FIXTURE_WORKSPACE || env.GITHUB_WORKSPACE || process.cwd(),
    outside:
      env.FIXTURE_OUTSIDE || path.join(env.RUNNER_TEMP || os.tmpdir(), 'cloud-cache-outside'),
    home: env.FIXTURE_HOME || os.homedir(),
  };
}

export function clearFixtureRoots(roots: FixtureRoots): void {
  for (const target of [
    path.join(roots.workspace, WORKSPACE_DIR),
    path.join(roots.outside, OUTSIDE_DIR),
    path.join(roots.home, HOME_DIR),
    path.join(roots.workspace, 'pwned'),
  ]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

export function buildFixtureTree(
  roots: FixtureRoots,
  options: FixtureOptions = {}
): FixtureManifest {
  clearFixtureRoots(roots);
  const entries: FixtureEntry[] = [];
  const w = (relative: string): string => `${WORKSPACE_DIR}/${relative}`;

  const file = (
    root: RootName,
    relative: string,
    content: string | Buffer,
    executable = false
  ): void => {
    const target = resolveIn(roots, root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    const markExecutable = executable && supportsExecutableBit;
    if (markExecutable) {
      fs.chmodSync(target, 0o755);
    }
    entries.push({
      root,
      path: relative,
      type: 'file',
      sha256: sha256(content),
      executable: markExecutable || undefined,
    });
  };
  const dir = (root: RootName, relative: string): void => {
    fs.mkdirSync(resolveIn(roots, root, relative), { recursive: true });
    entries.push({ root, path: relative, type: 'dir' });
  };
  const symlink = (root: RootName, relative: string, target: string): void => {
    const linkPath = resolveIn(roots, root, relative);
    // Both current targets are files (one dangling); Windows needs an explicit link type since
    // it cannot infer one for a target that does not exist, and defaults to POSIX behaviour
    // (no type argument) everywhere else.
    if (isWindows) {
      fs.symlinkSync(target, linkPath, 'file');
    } else {
      fs.symlinkSync(target, linkPath);
    }
    entries.push({ root, path: relative, type: 'symlink', target });
  };

  file('workspace', w('app/src/index.js'), 'console.log("cached");\n');
  dir('workspace', w('app/src/empty-dir'));
  file('workspace', w('app/bin/run.sh'), '#!/bin/sh\necho run\n', true);
  file('workspace', w('app/ünïcödé file.txt'), 'unicode\n');
  file('workspace', w('app/-leading-dash.txt'), 'dash\n');
  file('workspace', w('app/-C'), 'looks like a tar option\n');
  file('workspace', w('app/--checkpoint-action=exec=touch pwned'), 'option injection\n');
  file('workspace', w('packages/a/node_modules/dep/index.js'), 'a\n');
  file('workspace', w('packages/b/node_modules/dep/index.js'), 'b\n');
  const excluded = resolveIn(roots, 'workspace', w('packages/b/node_modules/.cache/secret.txt'));
  fs.mkdirSync(path.dirname(excluded), { recursive: true });
  fs.writeFileSync(excluded, 'must not be cached\n');
  file('workspace', w('big/blob.bin'), deterministicBytes(options.largeFileBytes ?? 1024 * 1024));

  const patterns = [
    w('app'),
    w('packages/*/node_modules/*'),
    `!${w('packages/b/node_modules/.cache')}`,
    w('big'),
  ];
  const absent: FixtureManifest['absent'] = [
    { root: 'workspace', path: w('packages/b/node_modules/.cache') },
    { root: 'workspace', path: 'pwned' },
    { root: 'workspace', path: w('app/pwned') },
  ];

  if (!options.portable) {
    symlink('workspace', w('app/link-to-index'), 'src/index.js');
    symlink('workspace', w('app/link-outside'), '../../outside-target-does-not-exist');
    file('outside', `${OUTSIDE_DIR}/config.json`, '{"cached":true}\n');
    file('home', `${HOME_DIR}/settings.txt`, 'home\n');
    patterns.push(path.join(roots.outside, OUTSIDE_DIR), `~/${HOME_DIR}`);
  }

  return { patterns, entries, absent };
}

export function verifyFixtureTree(manifest: FixtureManifest, roots: FixtureRoots): string[] {
  const problems: string[] = [];
  for (const entry of manifest.entries) {
    const target = resolveIn(roots, entry.root, entry.path);
    const label = `${entry.root}:${entry.path}`;

    if (entry.type === 'symlink') {
      try {
        const actual = fs.readlinkSync(target);
        if (normalizeLinkTarget(actual) !== normalizeLinkTarget(entry.target ?? '')) {
          problems.push(`${label}: symlink points to ${actual}, expected ${entry.target}`);
        }
      } catch {
        problems.push(`${label}: symlink is missing`);
      }
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch {
      problems.push(`${label}: missing`);
      continue;
    }
    if (entry.type === 'dir') {
      if (!stat.isDirectory()) {
        problems.push(`${label}: not a directory`);
      }
      continue;
    }
    if (!stat.isFile()) {
      problems.push(`${label}: not a regular file`);
      continue;
    }
    if (sha256(fs.readFileSync(target)) !== entry.sha256) {
      problems.push(`${label}: content differs`);
    }
    if (entry.executable && supportsExecutableBit && (stat.mode & 0o111) === 0) {
      problems.push(`${label}: lost its executable bit`);
    }
  }

  for (const item of manifest.absent) {
    if (fs.existsSync(resolveIn(roots, item.root, item.path))) {
      problems.push(`${item.root}:${item.path}: should not exist`);
    }
  }
  return problems;
}

function writePathsOutput(manifest: FixtureManifest): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const delimiter = 'CLOUD_CACHE_FIXTURE_PATHS';
    fs.appendFileSync(
      outputFile,
      `paths<<${delimiter}\n${manifest.patterns.join('\n')}\n${delimiter}\n`
    );
  }
  console.log(manifest.patterns.join('\n'));
}

const readManifest = (file: string): FixtureManifest =>
  JSON.parse(fs.readFileSync(file, 'utf8')) as FixtureManifest;

async function main(argv: string[]): Promise<void> {
  const [command, manifestFile, ...flags] = argv;
  const roots = rootsFromEnv(process.env);

  switch (command) {
    case 'build': {
      const largeIndex = flags.indexOf('--large-bytes');
      const manifest = buildFixtureTree(roots, {
        portable: flags.includes('--portable'),
        largeFileBytes: largeIndex >= 0 ? Number(flags[largeIndex + 1]) : undefined,
      });
      fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
      writePathsOutput(manifest);
      return;
    }
    case 'clear':
      clearFixtureRoots(roots);
      return;
    case 'verify': {
      const manifest = readManifest(manifestFile);
      const problems = verifyFixtureTree(manifest, roots);
      if (problems.length > 0) {
        console.error(problems.join('\n'));
        process.exit(1);
      }
      console.log(
        `Fixture verified: ${manifest.entries.length} entries, ${manifest.absent.length} absent paths`
      );
      return;
    }
    case 'paths':
      writePathsOutput(readManifest(manifestFile));
      return;
    default:
      throw new Error(`Unknown command "${command}". Use build, clear, verify or paths.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
