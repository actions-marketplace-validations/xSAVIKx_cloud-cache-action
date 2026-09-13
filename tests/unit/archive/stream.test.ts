import type { ArchiveCommand } from '../../../src/archive/tar';
import {
  captureStderrTail,
  createByteCounter,
  killIfRunning,
  spawnArchiveCommand,
  waitForExit,
} from '../../../src/archive/stream';

// The "tool" in every case is this Node binary itself, run with inline scripts, so these tests
// exercise real child processes (spawning, piping, exit codes, signals) without depending on tar.
const node = (script: string): ArchiveCommand => ({
  tool: process.execPath,
  args: ['-e', script],
});

describe('spawnArchiveCommand', () => {
  it('spawns without a shell and pipes stdout/stderr', async () => {
    const child = spawnArchiveCommand(
      node("process.stdout.write('out'); process.stderr.write('err'); process.exit(0);"),
      ['ignore', 'pipe', 'pipe']
    );
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    const stderrTail = captureStderrTail(child.stderr);
    await expect(waitForExit(child)).resolves.toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe('out');
    expect(stderrTail.lines()).toEqual(['err']);
  });

  it('inherits the archive exec environment (MSYS set)', async () => {
    const child = spawnArchiveCommand(
      node('process.stdout.write(process.env.MSYS || "");process.exit(0);'),
      ['ignore', 'pipe', 'ignore']
    );
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    await waitForExit(child);
    expect(Buffer.concat(chunks).toString()).toBe('winsymlinks:nativestrict');
  });
});

describe('waitForExit', () => {
  it('resolves with a non-zero exit code without throwing', async () => {
    const child = spawnArchiveCommand(node('process.exit(3);'), ['ignore', 'ignore', 'ignore']);
    await expect(waitForExit(child)).resolves.toBe(3);
  });

  it('rejects when the process is killed by a signal', async () => {
    const child = spawnArchiveCommand(node('setInterval(() => {}, 1000);'), [
      'ignore',
      'ignore',
      'ignore',
    ]);
    const exit = waitForExit(child);
    child.kill('SIGTERM');
    await expect(exit).rejects.toThrow(/signal/i);
  });

  it('rejects when the executable does not exist, without leaving a process behind', async () => {
    const child = spawnArchiveCommand({ tool: '/does/not/exist/cloud-cache-tool', args: [] }, [
      'ignore',
      'ignore',
      'ignore',
    ]);
    await expect(waitForExit(child)).rejects.toThrow();
  });
});

describe('killIfRunning', () => {
  it('kills a process that is still running', async () => {
    const child = spawnArchiveCommand(node('setInterval(() => {}, 1000);'), [
      'ignore',
      'ignore',
      'ignore',
    ]);
    const exit = waitForExit(child);
    killIfRunning(child);
    await expect(exit).rejects.toThrow();
    expect(child.killed).toBe(true);
  });

  it('does nothing, and does not throw, once the process has already exited', async () => {
    const child = spawnArchiveCommand(node('process.exit(0);'), ['ignore', 'ignore', 'ignore']);
    await waitForExit(child);
    expect(() => killIfRunning(child)).not.toThrow();
  });
});

describe('captureStderrTail', () => {
  it('returns an empty tail for a null stream', () => {
    expect(captureStderrTail(null).lines()).toEqual([]);
  });

  it('caps the tail at maxLines, keeping the most recent lines', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line-${i}`);
    const child = spawnArchiveCommand(
      node(`process.stderr.write(${JSON.stringify(`${lines.join('\n')}\n`)}); process.exit(0);`),
      ['ignore', 'ignore', 'pipe']
    );
    const tail = captureStderrTail(child.stderr, 5);
    await waitForExit(child);
    // Give the 'data' events a tick to flush after 'exit'.
    await new Promise((resolve) => setImmediate(resolve));
    expect(tail.lines()).toEqual(lines.slice(-5));
  });

  it('includes a trailing partial line with no newline', async () => {
    const child = spawnArchiveCommand(
      node("process.stderr.write('partial-no-newline'); process.exit(0);"),
      ['ignore', 'ignore', 'pipe']
    );
    const tail = captureStderrTail(child.stderr);
    await waitForExit(child);
    await new Promise((resolve) => setImmediate(resolve));
    expect(tail.lines()).toEqual(['partial-no-newline']);
  });
});

describe('createByteCounter', () => {
  it('passes data through unchanged while counting total bytes', async () => {
    const counter = createByteCounter();
    const received: Buffer[] = [];
    counter.stream.on('data', (chunk: Buffer) => received.push(chunk));
    counter.stream.write(Buffer.from('hello '));
    counter.stream.end(Buffer.from('world'));
    await new Promise((resolve) => counter.stream.on('end', resolve));
    expect(Buffer.concat(received).toString()).toBe('hello world');
    expect(counter.count()).toBe('hello world'.length);
  });

  it('counts zero for an empty stream', async () => {
    const counter = createByteCounter();
    counter.stream.resume();
    counter.stream.end();
    await new Promise((resolve) => counter.stream.on('end', resolve));
    expect(counter.count()).toBe(0);
  });
});

describe('piping a spawned command through the byte counter (backpressure)', () => {
  it('streams a large payload from stdout to a slow consumer without dropping bytes', async () => {
    const totalBytes = 2 * 1024 * 1024; // larger than typical pipe/highWaterMark buffers
    const child = spawnArchiveCommand(
      node(
        `const chunk = Buffer.alloc(${totalBytes}, 97); ` +
          `process.stdout.write(chunk, () => process.exit(0));`
      ),
      ['ignore', 'pipe', 'ignore']
    );
    const counter = createByteCounter();
    let received = 0;
    let paused = false;
    counter.stream.on('data', (chunk: Buffer) => {
      received += chunk.length;
      // Pause the reader once, briefly, to force the writer side to feel real backpressure.
      if (!paused) {
        paused = true;
        counter.stream.pause();
        setTimeout(() => counter.stream.resume(), 50);
      }
    });
    const ended = new Promise((resolve) => counter.stream.on('end', resolve));
    child.stdout?.pipe(counter.stream);
    await waitForExit(child);
    await ended;
    expect(received).toBe(totalBytes);
    expect(counter.count()).toBe(totalBytes);
  }, 20_000);
});
