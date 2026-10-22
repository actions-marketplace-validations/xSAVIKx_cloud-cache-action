import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { createSha256Tap, sha256File } from './checksum';
import type { CompressionConfig, CompressionMethod } from './compression';
import {
  captureStderrTail,
  spawnArchiveCommand,
  waitForExit,
  waitForExitAfterKill,
} from './stream';

export type TarFlavor = 'gnu' | 'bsd';

export interface TarTool {
  path: string;
  flavor: TarFlavor;
}

export interface ArchiveCommand {
  tool: string;
  args: string[];
}

export interface ToolLookup {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Resolves a tool on PATH; '' when absent. */
  which: (tool: string) => Promise<string>;
  exists: (file: string) => boolean;
}

export interface ArchivePlan {
  tar: TarTool;
  platform: NodeJS.Platform;
  compression: CompressionMethod;
  archivePath: string;
  workspace: string;
  /** Scratch directory; BSD tar on Windows writes its intermediate .tar here. */
  tempDir: string;
  /** Compression level for saving; undefined keeps the tool's own default. */
  level?: number;
}

const ZSTD_COMPRESS = 'zstd -T0 --long=30';
const ZSTD_DECOMPRESS = 'zstd -d --long=30';

function systemLookup(): ToolLookup {
  return {
    platform: process.platform,
    env: process.env,
    which: (tool) => io.which(tool, false),
    exists: (file) => fs.existsSync(file),
  };
}

/** Picks tar the way actions/cache does: GNU tar where available, BSD tar otherwise. */
export async function findTar(lookup: ToolLookup = systemLookup()): Promise<TarTool> {
  if (lookup.platform === 'win32') {
    const programFiles = lookup.env.ProgramFiles || 'C:\\Program Files';
    const gnuTar = path.win32.join(programFiles, 'Git', 'usr', 'bin', 'tar.exe');
    if (lookup.exists(gnuTar)) {
      return { path: gnuTar, flavor: 'gnu' };
    }
    const systemRoot = lookup.env.SystemRoot || 'C:\\Windows';
    const systemTar = path.win32.join(systemRoot, 'System32', 'tar.exe');
    if (lookup.exists(systemTar)) {
      return { path: systemTar, flavor: 'bsd' };
    }
    throw new Error(`tar was not found at ${gnuTar} or ${systemTar}`);
  }

  if (lookup.platform === 'darwin') {
    const gtar = await lookup.which('gtar');
    if (gtar) {
      return { path: gtar, flavor: 'gnu' };
    }
  }

  const tar = await lookup.which('tar');
  if (!tar) {
    throw new Error('tar was not found on PATH');
  }
  return { path: tar, flavor: lookup.platform === 'darwin' ? 'bsd' : 'gnu' };
}

const slashes = (value: string): string => value.replace(/\\/g, '/');

/**
 * BSD tar on Windows cannot pipe through zstd reliably, so zstd runs as its own command. This
 * also means that combination cannot stream (Task 8): callers that want to stream check this
 * first and fall back to a temporary archive file when it is true.
 */
export function usesSeparateZstd(
  plan: Pick<ArchivePlan, 'tar' | 'platform' | 'compression'>
): boolean {
  return plan.tar.flavor === 'bsd' && plan.platform === 'win32' && plan.compression === 'zstd';
}

function platformFlags(plan: ArchivePlan): string[] {
  if (plan.tar.flavor !== 'gnu') {
    return [];
  }
  if (plan.platform === 'win32') {
    return ['--force-local'];
  }
  if (plan.platform === 'darwin') {
    return ['--delay-directory-restore'];
  }
  return [];
}

function zstdCompressProgram(level?: number): string {
  return level === undefined ? ZSTD_COMPRESS : `zstd -${level} -T0 --long=30`;
}

function compressionFlags(method: CompressionMethod, program: string, level?: number): string[] {
  if (method === 'zstd') {
    return ['--use-compress-program', program];
  }
  return level === undefined ? ['-z'] : ['--use-compress-program', `gzip -${level}`];
}

/** One entry per line; entries starting with '-' get './' so no tar treats them as options. */
export function formatManifest(entries: readonly string[]): string {
  return `${entries.map((entry) => (entry.startsWith('-') ? `./${entry}` : entry)).join('\n')}\n`;
}

/**
 * Builds the commands that create the archive. With `toStdout`, tar writes the archive to stdout
 * and the commands do not name `archivePath`. The two-command zstd plan cannot do this.
 */
export function buildCreateCommands(
  plan: ArchivePlan & { manifestPath: string; toStdout?: boolean }
): ArchiveCommand[] {
  const separateZstd = usesSeparateZstd(plan);
  if (separateZstd && plan.toStdout) {
    throw new Error('The separate zstd command cannot write the archive to stdout');
  }
  const tarFile = separateZstd
    ? path.join(plan.tempDir, 'cache.tar')
    : plan.toStdout
      ? '-'
      : plan.archivePath;

  const args: string[] = [];
  if (plan.tar.flavor === 'gnu') {
    args.push('--posix');
  }
  args.push('-cf', slashes(tarFile), '-P', '-C', slashes(plan.workspace));
  if (plan.tar.flavor === 'gnu') {
    args.push('--verbatim-files-from');
  }
  args.push('-T', slashes(plan.manifestPath), ...platformFlags(plan));

  if (!separateZstd) {
    args.push(...compressionFlags(plan.compression, zstdCompressProgram(plan.level), plan.level));
    return [{ tool: plan.tar.path, args }];
  }
  return [
    { tool: plan.tar.path, args },
    {
      tool: 'zstd',
      args: [
        ...(plan.level === undefined ? [] : [`-${plan.level}`]),
        '-T0',
        '--long=30',
        '--force',
        '-o',
        slashes(plan.archivePath),
        slashes(tarFile),
      ],
    },
  ];
}

export function buildExtractCommands(plan: ArchivePlan): ArchiveCommand[] {
  if (usesSeparateZstd(plan)) {
    const tarFile = path.join(plan.tempDir, 'cache.tar');
    return [
      {
        tool: 'zstd',
        args: ['-d', '--long=30', '--force', '-o', slashes(tarFile), slashes(plan.archivePath)],
      },
      {
        tool: plan.tar.path,
        args: ['-xf', slashes(tarFile), '-P', '-C', slashes(plan.workspace)],
      },
    ];
  }
  return [
    {
      tool: plan.tar.path,
      args: [
        '-xf',
        slashes(plan.archivePath),
        '-P',
        '-C',
        slashes(plan.workspace),
        ...platformFlags(plan),
        ...compressionFlags(plan.compression, ZSTD_DECOMPRESS),
      ],
    },
  ];
}

/** MSYS value for every archive command: native symlinks, or a failure when not possible. */
export const MSYS_NATIVE_SYMLINKS = 'winsymlinks:nativestrict';

/**
 * MSYS value for the one extract retry. The MSYS2 runtime copies the link target. It does not use
 * 'winsymlinks:native', because that value falls back to WSL symlinks, and Windows programs
 * cannot open those.
 */
export const MSYS_COPY_SYMLINKS = 'winsymlinks:deepcopy';

/**
 * Options for every tar and zstd command. Like actions/cache, sets MSYS so Git's MSYS tar on
 * Windows extracts symlinks as native links instead of copies; other platforms ignore it.
 */
export function archiveExecOptions(
  env: NodeJS.ProcessEnv = process.env,
  msys: string = MSYS_NATIVE_SYMLINKS
): exec.ExecOptions {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) {
      inherited[name] = value;
    }
  }
  return { env: { ...inherited, MSYS: msys } };
}

// GNU tar prints "<tar>: <file>: Cannot create symlink to <target>: <strerror>". The MSYS runtime
// maps ERROR_PRIVILEGE_NOT_HELD to EPERM. The program name and the quote marks change, so the
// patterns do not include them.
const SYMLINK_EPERM_LINE = /: Cannot create symlink to .*: Operation not permitted$/;
const TAR_SUMMARY_LINE = /: Exiting with failure status due to previous errors$/;

/** Reads stderr in chunks and finds out if a symlink permission error is the only failure. */
class SymlinkErrorDetector {
  private readonly decoder = new StringDecoder('utf8');
  private partial = '';
  private symlinkErrors = 0;
  private otherLines = 0;

  write(chunk: Buffer | string): void {
    const lines = (this.partial + this.decoder.write(Buffer.from(chunk))).split(/\r?\n/);
    this.partial = lines.pop() ?? '';
    for (const line of lines) {
      this.classify(line);
    }
  }

  matches(): boolean {
    this.classify(this.partial + this.decoder.end());
    this.partial = '';
    return this.symlinkErrors > 0 && this.otherLines === 0;
  }

  private classify(line: string): void {
    const text = line.trimEnd();
    if (!text || TAR_SUMMARY_LINE.test(text)) {
      return;
    }
    if (SYMLINK_EPERM_LINE.test(text)) {
      this.symlinkErrors++;
    } else {
      this.otherLines++;
    }
  }
}

/**
 * True when tar stderr shows only symlinks that tar could not create because of a missing
 * privilege. Any other error line makes this false, so a retry cannot hide that error.
 */
export function isSymlinkPermissionError(stderr: string): boolean {
  const detector = new SymlinkErrorDetector();
  detector.write(stderr);
  return detector.matches();
}

/**
 * True for Git's GNU tar on Windows, the only tar that reads MSYS. BSD tar
 * (C:\Windows\System32\tar.exe) ignores MSYS, so a retry cannot change its result.
 */
export function usesSymlinkFallback(plan: Pick<ArchivePlan, 'tar' | 'platform'>): boolean {
  return plan.platform === 'win32' && plan.tar.flavor === 'gnu';
}

const SYMLINK_FALLBACK_WARNING =
  'tar could not create native symlinks: Operation not permitted. The usual cause is a runner ' +
  'account without the SeCreateSymbolicLinkPrivilege privilege while Windows Developer Mode is ' +
  'off. Another possible cause is a volume that does not support symlinks. The action extracts ' +
  `the archive again with MSYS=${MSYS_COPY_SYMLINKS}. Symlinks are restored as copies of their ` +
  'targets, not as links.';

async function run(commands: ArchiveCommand[], options = archiveExecOptions()): Promise<void> {
  for (const command of commands) {
    // exec parses its first argument as a command line, so quote paths that contain spaces.
    await exec.exec(`"${command.tool}"`, command.args, options);
  }
}

/**
 * Runs the extract commands for a plan. On Windows with Git's GNU tar, a first attempt that fails
 * only because native symlinks need a privilege is run one more time with copied symlinks.
 * The retry needs no cleanup. GNU tar continues after a failed symlink, so the first attempt
 * writes every other member, and the retry replaces each of them. A copy needs its target to
 * exist, so these files also let the retry copy a link that comes before its target.
 */
export async function runExtract(
  plan: ArchivePlan,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const commands = buildExtractCommands(plan);
  // One detector reads the stderr of every command in the list. This is correct only for one
  // command: the separate zstd step of a two-command plan writes status lines to stderr, and
  // these lines would stop every retry. Git's GNU tar always gets one command, so a plan with
  // more commands runs without the fallback.
  if (!usesSymlinkFallback(plan) || commands.length !== 1) {
    await run(commands, archiveExecOptions(env));
    return;
  }
  const detector = new SymlinkErrorDetector();
  const options = archiveExecOptions(env);
  try {
    await run(commands, {
      ...options,
      listeners: { stderr: (data: Buffer) => detector.write(data) },
    });
  } catch (err) {
    if (!detector.matches()) {
      throw err;
    }
    core.warning(SYMLINK_FALLBACK_WARNING);
    await run(commands, archiveExecOptions(env, MSYS_COPY_SYMLINKS));
  }
}

/**
 * Runs one create command that writes the archive to stdout. The sha256 tap hashes the bytes on
 * their way to `archivePath`, so the file is not read again. On a failure, this stops tar,
 * removes the partial file, and throws the error text of `run()` with the stderr tail added.
 */
async function writeArchiveFromStdout(
  command: ArchiveCommand,
  archivePath: string
): Promise<string> {
  const child = spawnArchiveCommand(command, ['ignore', 'pipe', 'pipe']);
  // exec writes tar's stderr to the log. Do the same, so that tar warnings stay visible.
  child.stderr?.on('data', (chunk: string) => process.stderr.write(chunk));
  const stderrTail = captureStderrTail(child.stderr);
  const tarClose = waitForExit(child);
  const tap = createSha256Tap();
  const file = fs.createWriteStream(archivePath);
  const fileClosed = new Promise<void>((resolve) => file.once('close', () => resolve()));
  try {
    const [, code] = await Promise.all([
      pipeline(child.stdout as Readable, tap.stream, file),
      tarClose,
    ]);
    if (code !== 0) {
      const tail = stderrTail.lines();
      const message = `The process '${command.tool}' failed with exit code ${code}`;
      throw new Error(tail.length === 0 ? message : `${message}\n${tail.join('\n')}`);
    }
    await fileClosed;
    return tap.digest();
  } catch (err) {
    // When the pipe fails first, tar can still run. Stop it and wait, bounded, for it to close.
    child.stdout?.destroy();
    await waitForExitAfterKill(child, tarClose);
    file.destroy();
    await fileClosed;
    try {
      fs.rmSync(archivePath, { force: true });
    } catch {
      // The tar or pipe error is the one to report, not a failed removal.
    }
    throw err;
  }
}

/** Creates the archive and returns the sha256 of its bytes. */
export async function createArchive(
  archivePath: string,
  entries: readonly string[],
  compression: CompressionConfig,
  workspace: string,
  level?: number
): Promise<{ sha256: string }> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-tar-'));
  try {
    const manifestPath = path.join(tempDir, 'manifest.txt');
    fs.writeFileSync(manifestPath, formatManifest(entries));
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    const tar = await findTar();
    const plan = {
      tar,
      platform: process.platform,
      compression: compression.method,
      archivePath,
      workspace,
      tempDir,
      manifestPath,
      level,
    };
    if (usesSeparateZstd(plan)) {
      // Two commands write files, so the archive is hashed after they finish.
      await run(buildCreateCommands(plan));
      return { sha256: await sha256File(archivePath) };
    }
    const [command] = buildCreateCommands({ ...plan, toStdout: true });
    return { sha256: await writeArchiveFromStdout(command, archivePath) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function extractArchive(
  archivePath: string,
  compression: CompressionConfig,
  workspace: string
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-tar-'));
  try {
    fs.mkdirSync(workspace, { recursive: true });
    const tar = await findTar();
    await runExtract({
      tar,
      platform: process.platform,
      compression: compression.method,
      archivePath,
      workspace,
      tempDir,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function getArchiveSize(archivePath: string): number {
  try {
    return fs.statSync(archivePath).size;
  } catch {
    return 0;
  }
}
