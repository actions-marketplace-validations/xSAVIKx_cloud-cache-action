/**
 * Starts SeaweedFS natively, so CI can test against real S3 on macOS and Windows, where Docker
 * cannot run Linux images. Downloads the pinned release for this runner, verifies it, starts an
 * S3 server on 127.0.0.1:8333 with tests/fixtures/seaweedfs-s3.json, and creates the test bucket.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '4.46';
const ASSETS: Record<string, { name: string; sha256: string }> = {
  'linux-x64': {
    name: 'linux_amd64.tar.gz',
    sha256: 'f4c654a72353c36bd8ae03c8879b81588dc29ffee0fa87594d8716a3d9347ad5',
  },
  'darwin-arm64': {
    name: 'darwin_arm64.tar.gz',
    sha256: '1d26b6cd43a6ed4f8c315bac15a19334270e5c84505fbf7cc4fdb1e251a71bc5',
  },
  'win32-x64': {
    name: 'windows_amd64.zip',
    sha256: 'd89d62fb56595f9ad2f5e62fc76943cded478cf40d0fe69868b52488a8d1d339',
  },
};
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S3_PORT = 8333;

async function waitForS3(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${S3_PORT}/`);
      // Anonymous requests are refused once the S3 gateway is up with authentication enabled.
      if (response.status === 403 || response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`SeaweedFS S3 did not start within ${timeoutMs / 1000}s`);
}

async function main(): Promise<void> {
  const asset = ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) {
    throw new Error(`No pinned SeaweedFS ${VERSION} build for ${process.platform}-${process.arch}`);
  }

  const workDir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'seaweedfs');
  const dataDir = path.join(workDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const archive = path.join(workDir, asset.name);
  const url = `https://github.com/seaweedfs/seaweedfs/releases/download/${VERSION}/${asset.name}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Downloading ${url} failed with HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== asset.sha256) {
    throw new Error(`Checksum mismatch for ${asset.name}: got ${digest}, expected ${asset.sha256}`);
  }
  fs.writeFileSync(archive, bytes);

  // System32 tar (bsdtar) reads zip; Git's GNU tar, which may be first on PATH, does not.
  const tar =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  execFileSync(tar, ['-xf', archive, '-C', workDir], { stdio: 'inherit' });

  const weed = path.join(workDir, process.platform === 'win32' ? 'weed.exe' : 'weed');
  const log = fs.openSync(path.join(workDir, 'weed.log'), 'a');
  const child = spawn(
    weed,
    [
      'server',
      '-ip=127.0.0.1',
      '-ip.bind=127.0.0.1',
      `-dir=${dataDir}`,
      '-s3',
      `-s3.port=${S3_PORT}`,
      // Explicit, non-default ports: 8080 (SeaweedFS's default volume port) can already be in
      // use on this host and on CI runners.
      '-master.port=19333',
      '-volume.port=18080',
      '-filer.port=18888',
      `-s3.config=${path.join(REPO, 'tests', 'fixtures', 'seaweedfs-s3.json')}`,
      '-volume.max=0',
      '-master.volumeSizeLimitMB=64',
    ],
    { detached: true, stdio: ['ignore', log, log], windowsHide: true }
  );
  child.unref();
  fs.writeFileSync(path.join(workDir, 'weed.pid'), String(child.pid));

  await waitForS3(90_000);
  execFileSync(process.execPath, [path.join(REPO, 'tests', 'support', 's3Server.ts')], {
    stdio: 'inherit',
  });
  console.log(
    `SeaweedFS ${VERSION} serves S3 on 127.0.0.1:${S3_PORT} (log: ${path.join(workDir, 'weed.log')})`
  );
}

await main();
