import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CompressionConfig } from './compression';

export async function createArchive(
  archivePath: string,
  paths: string[],
  compression: CompressionConfig,
  enableCrossOsArchive = false
): Promise<void> {
  const tarPath = await io.which('tar', true);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-archive-'));
  const manifestFile = path.join(tempDir, 'manifest.txt');

  // Normalize all input paths
  const normalizedPaths = paths.map((p) => {
    let norm = p.trim().replace(/\\+/g, '/');
    if (enableCrossOsArchive && /^[a-zA-Z]:\//.test(norm)) {
      // Strip Windows drive letter for cross-os archive compatibility
      norm = norm.replace(/^[a-zA-Z]:\//, '/');
    }
    return norm;
  });

  fs.writeFileSync(manifestFile, normalizedPaths.join('\n'));

  // Ensure target folder exists
  const targetDir = path.dirname(archivePath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const args: string[] = [];

  // Compression flag
  if (compression.method === 'zstd') {
    args.push('--use-compress-program', 'zstd -T0 -3');
  } else {
    args.push('-z');
  }

  args.push('-cf', archivePath, '-P', '-T', manifestFile);

  core.debug(`Creating tar archive using command: ${tarPath} ${args.join(' ')}`);

  try {
    await exec.exec(`"${tarPath}"`, args);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}

export async function extractArchive(
  archivePath: string,
  compression: CompressionConfig,
  workingDirectory = process.cwd()
): Promise<void> {
  const tarPath = await io.which('tar', true);
  const args: string[] = [];

  if (compression.method === 'zstd') {
    args.push('--use-compress-program', 'zstd -d');
  } else {
    args.push('-z');
  }

  args.push('-xf', archivePath, '-P', '-C', workingDirectory);

  core.debug(`Extracting tar archive using command: ${tarPath} ${args.join(' ')}`);
  await exec.exec(`"${tarPath}"`, args);
}

export function getArchiveSize(archivePath: string): number {
  try {
    const stats = fs.statSync(archivePath);
    return stats.size;
  } catch {
    return 0;
  }
}
