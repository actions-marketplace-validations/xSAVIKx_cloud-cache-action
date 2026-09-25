import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const isWindows = process.platform === 'win32';

/** A fresh temporary directory, with symlinks (macOS /var) and Windows 8.3 short names resolved. */
export function makeTempDir(label: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `cloud-cache-${label}-`)));
}

/** Writes files given as `/`-separated relative paths, creating parent directories. */
export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function applyEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/** Sets environment variables in place and returns a function that restores them. */
export function setEnv(values: Record<string, string | undefined>): () => void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  applyEnv(values);
  return () => applyEnv(previous);
}
