/**
 * Hashes a file while other code writes it, in a worker thread. A ranged download writes parts at
 * their offsets in any order; the caller reports each time the start of the file grows, and the
 * worker hashes only the new bytes, in order. The main thread stays free for the sockets, and the
 * digest is ready almost as soon as the last part is on disk.
 */
import * as fs from 'node:fs';
import { Worker } from 'node:worker_threads';

export interface PrefixHasher {
  /** Says that bytes `[0, end)` are on disk and do not change again. */
  advance(end: number): void;
  /**
   * Hashes up to `size` bytes and resolves the hex sha256 digest. Stops the worker on every
   * path, also when it throws an earlier failure.
   */
  finish(size: number): Promise<string>;
  /**
   * Stops the worker and closes the file; a second call does nothing. The promise resolves when
   * the file is closed. A caller can ignore it.
   */
  close(): Promise<void>;
}

/**
 * The worker, as plain CommonJS for `eval: true`: the action ships as one bundle, so a worker in a
 * separate file would not be in it. The worker reads from a file descriptor that the main thread
 * owns. After a failure it hashes nothing more and sends the error in reply to `finish`.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { readSync } = require('node:fs');
const { createHash } = require('node:crypto');
const hash = createHash('sha256');
const buffer = Buffer.allocUnsafe(1024 * 1024);
let hashed = 0;
let failure;
parentPort.on('message', (message) => {
  const end = message.finish ? message.size : message.end;
  try {
    while (failure === undefined && hashed < end) {
      const read = readSync(workerData.fd, buffer, 0, Math.min(buffer.length, end - hashed), hashed);
      if (read === 0) {
        throw new Error('The file ended after ' + hashed + ' of ' + end + ' bytes');
      }
      hash.update(buffer.subarray(0, read));
      hashed += read;
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  if (message.finish) {
    parentPort.postMessage(failure === undefined ? { digest: hash.digest('hex') } : { error: failure });
  }
});
`;

type WorkerReply = { digest: string } | { error: string };

/**
 * Starts a hasher for `filePath`. The file must exist; the function opens it read-only at once.
 * Call `finish` or `close` on every path, or the worker keeps the process alive.
 */
export function createPrefixHasher(filePath: string): PrefixHasher {
  const fd = fs.openSync(filePath, 'r');
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { fd } });
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
  let advanced = 0;
  let stopped: Promise<void> | undefined;
  let failure: Error | undefined;
  let pending: { resolve: (digest: string) => void; reject: (err: Error) => void } | undefined;

  const fail = (err: Error): void => {
    failure ??= err;
    pending?.reject(failure);
    pending = undefined;
  };
  worker.on('message', (reply: WorkerReply) => {
    if ('error' in reply) {
      fail(new Error(`Could not hash ${filePath}: ${reply.error}`));
      return;
    }
    pending?.resolve(reply.digest);
    pending = undefined;
  });
  worker.on('error', (err: Error) => fail(err));
  worker.on('exit', () => fail(new Error('The hash worker stopped before it sent the digest')));

  const close = (): Promise<void> => {
    if (!stopped) {
      fail(new Error('The hasher is closed'));
      // Close the file only after the worker has stopped, so that no read uses a closed or
      // reused descriptor.
      stopped = worker.terminate().then(
        () => closeFd(fd),
        () => closeFd(fd)
      );
    }
    return stopped;
  };

  return {
    advance(end: number): void {
      if (stopped || end <= advanced) {
        return;
      }
      advanced = end;
      worker.postMessage({ end });
    },
    async finish(size: number): Promise<string> {
      if (stopped || failure) {
        // Keep the error that came first: close() sets its own error when none is set.
        const err = failure ?? new Error('The hasher is closed');
        await close();
        throw err;
      }
      try {
        return await new Promise<string>((resolve, reject) => {
          pending = { resolve, reject };
          worker.postMessage({ finish: true, size });
        });
      } finally {
        await close();
      }
    },
    close,
  };
}

function closeFd(fd: number): Promise<void> {
  return new Promise((resolve) => fs.close(fd, () => resolve()));
}
