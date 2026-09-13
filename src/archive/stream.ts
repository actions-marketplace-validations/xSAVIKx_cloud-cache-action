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
 * Resolves with the exit code once the process AND its stdio streams have fully closed (the
 * 'close' event, not 'exit'), so by the time this resolves, everything the process wrote to
 * stdout/stderr has already drained and is safe to read. Rejects when it could not be spawned at
 * all (e.g. the tool is missing) or was terminated by a signal.
 */
export function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
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

/**
 * Kills the process if it is still running, then waits (bounded) for it to actually close, so a
 * caller's cleanup — removing a temp directory, reading the final stderr tail — does not race
 * stdio that is still draining or a process that still has files open. Pass the same promise
 * `waitForExit` already returned for this child: a fresh call would attach a listener for a
 * one-shot event that may already have fired, and would then hang until the timeout. Never
 * rejects: giving up on an orderly wait after `timeoutMs` is not a caller-visible failure.
 */
export async function waitForExitAfterKill(
  child: ChildProcess,
  exit: Promise<number>,
  timeoutMs = 5000
): Promise<void> {
  killIfRunning(child);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([
      exit.then(
        () => undefined,
        () => undefined
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface StderrTail {
  /** The most recent lines written to the stream so far, oldest first, capped to maxLines. */
  lines(): string[];
}

/** Caps unterminated output so one very long (or binary) line cannot grow this without bound. */
const MAX_PARTIAL_LENGTH = 8 * 1024;

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
  // setEncoding decodes multi-byte UTF-8 characters correctly across chunk boundaries, which
  // chunk.toString('utf8') per chunk cannot.
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk: string) => {
    partial += chunk;
    const lines = partial.split(/\r?\n/);
    partial = lines.pop() ?? '';
    for (const line of lines) {
      push(line);
    }
    if (partial.length > MAX_PARTIAL_LENGTH) {
      partial = partial.slice(-MAX_PARTIAL_LENGTH);
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
