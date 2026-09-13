import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { archiveExecOptions, type ArchiveCommand } from './tar';

/**
 * Spawns one tar/zstd command for streaming (Task 8): no shell, so paths and arguments never
 * need quoting, unlike the `exec.exec` command line `run()` uses for the file-based path.
 */
export function spawnArchiveCommand(command: ArchiveCommand, stdio: StdioOptions): ChildProcess {
  return spawn(command.tool, command.args, {
    env: archiveExecOptions().env,
    windowsHide: true,
    stdio,
  });
}

/**
 * Resolves with the exit code once the process exits normally, or rejects when it could not be
 * spawned at all (e.g. the tool is missing) or was terminated by a signal.
 */
export function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }
      reject(
        new Error(`${child.spawnfile ?? 'the archive command'} was terminated by signal ${signal}`)
      );
    });
  });
}

/** Kills the process only if it has not already exited or been signalled, so this never throws. */
export function killIfRunning(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
  }
}

export interface StderrTail {
  /** The most recent lines written to the stream so far, oldest first, capped to maxLines. */
  lines(): string[];
}

/** Collects up to `maxLines` of the most recent text a stream has produced, for error messages. */
export function captureStderrTail(stream: Readable | null, maxLines = 20): StderrTail {
  const tail: string[] = [];
  let partial = '';
  const push = (line: string): void => {
    tail.push(line);
    if (tail.length > maxLines) {
      tail.shift();
    }
  };
  stream?.on('data', (chunk: Buffer | string) => {
    partial += chunk.toString('utf8');
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      push(line);
    }
  });
  return {
    lines: () => (partial ? [...tail, partial].slice(-maxLines) : tail.slice(-maxLines)),
  };
}

export interface ByteCounter {
  /** A pass-through Transform: whatever is written comes out unchanged. */
  stream: Transform;
  /** Total bytes that have passed through so far. */
  count(): number;
}

/** Counts bytes flowing through a streaming pipeline, standing in for a known archive size. */
export function createByteCounter(): ByteCounter {
  let total = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      callback(null, chunk);
    },
  });
  return { stream, count: () => total };
}
