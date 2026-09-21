/**
 * Measures how the transfer inputs change save and restore speed against one S3 provider, by
 * running the built `save-only` and `restore-only` bundles the way the runner does (INPUT_* in
 * the environment) and reading each step's `cloud-cache-metrics` file.
 *
 *   node tests/ci/benchmark.ts
 *
 * Environment: BENCH_BUCKET (required), BENCH_ENDPOINT, BENCH_REGION, BENCH_PROVIDER,
 * BENCH_ACCESS_KEY, BENCH_SECRET_KEY (or the AWS_* variables the action already falls back to),
 * BENCH_SIZE_MB (default 512), BENCH_REPEATS (default 2), BENCH_LABEL (name in the report).
 * Writes benchmark-results.json and benchmark-results.md into BENCH_OUT (default the workspace),
 * and appends the table to GITHUB_STEP_SUMMARY when set. Every object is deleted afterwards.
 */
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MiB = 1024 * 1024;

interface Metrics {
  step: string;
  bytes: number;
  durationMs: number;
  transferDurationMs?: number;
  streaming?: boolean;
  downloadParts?: number;
  outcome: string;
}

interface UploadConfig {
  name: string;
  concurrency: number;
  chunkSize: number;
  streaming: boolean;
}

interface DownloadConfig {
  name: string;
  concurrency: number;
  chunkSize: number;
  streaming: boolean;
}

interface Sample {
  kind: 'save' | 'restore';
  config: string;
  inputs: Record<string, string>;
  bytes: number;
  transferMs: number[];
  totalMs: number[];
  downloadParts?: number;
}

const env = (name: string, fallback = ''): string => process.env[name] ?? fallback;
const sizeMb = Number(env('BENCH_SIZE_MB', '512'));
const repeats = Math.max(1, Number(env('BENCH_REPEATS', '2')));
const label = env('BENCH_LABEL', env('BENCH_PROVIDER', 's3'));
const workspace = env('GITHUB_WORKSPACE', process.cwd());
const outDir = env('BENCH_OUT', workspace);
const runId = `${env('GITHUB_RUN_ID', String(Date.now()))}-${env('GITHUB_RUN_ATTEMPT', '1')}`;
const prefix = `bench/${runId}/`;
const payloadDir = path.join(workspace, 'bench-payload');

const UPLOADS: UploadConfig[] = [
  { name: 'v1.3 defaults: 4 x 10 MiB', concurrency: 4, chunkSize: 10 * MiB, streaming: false },
  { name: 'defaults: 8 x 64 MiB', concurrency: 8, chunkSize: 64 * MiB, streaming: false },
  { name: '16 x 32 MiB', concurrency: 16, chunkSize: 32 * MiB, streaming: false },
  { name: 'streaming, defaults: 8 x 64 MiB', concurrency: 8, chunkSize: 64 * MiB, streaming: true },
];

const DOWNLOADS: DownloadConfig[] = [
  { name: 'single request (concurrency 1)', concurrency: 1, chunkSize: 4 * MiB, streaming: false },
  { name: 'defaults: 8 x 4 MiB', concurrency: 8, chunkSize: 4 * MiB, streaming: false },
  { name: '8 x 16 MiB', concurrency: 8, chunkSize: 16 * MiB, streaming: false },
  { name: '16 x 8 MiB', concurrency: 16, chunkSize: 8 * MiB, streaming: false },
  { name: '32 x 16 MiB', concurrency: 32, chunkSize: 16 * MiB, streaming: false },
  { name: 'streaming, single request', concurrency: 1, chunkSize: 4 * MiB, streaming: true },
  { name: 'streaming, defaults: 8 x 4 MiB', concurrency: 8, chunkSize: 4 * MiB, streaming: true },
  { name: 'streaming, 16 x 8 MiB', concurrency: 16, chunkSize: 8 * MiB, streaming: true },
];

/** Random bytes do not compress, so the archive is about as large as the payload. */
function writePayload(): Record<string, string> {
  fs.rmSync(payloadDir, { recursive: true, force: true });
  fs.mkdirSync(payloadDir, { recursive: true });
  const digests: Record<string, string> = {};
  const files = 4;
  const perFile = Math.floor((sizeMb * MiB) / files);
  for (let i = 0; i < files; i++) {
    const name = `part-${i}.bin`;
    const hash = createHash('sha256');
    const fd = fs.openSync(path.join(payloadDir, name), 'w');
    let remaining = perFile;
    while (remaining > 0) {
      const chunk = randomBytes(Math.min(remaining, 8 * MiB));
      fs.writeSync(fd, chunk);
      hash.update(chunk);
      remaining -= chunk.length;
    }
    fs.closeSync(fd);
    digests[name] = hash.digest('hex');
  }
  return digests;
}

function digestPayload(): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const name of fs.readdirSync(payloadDir).sort()) {
    digests[name] = createHash('sha256')
      .update(fs.readFileSync(path.join(payloadDir, name)))
      .digest('hex');
  }
  return digests;
}

function providerInputs(): Record<string, string> {
  const inputs: Record<string, string> = {
    bucket: env('BENCH_BUCKET'),
    prefix,
    'scoped-to-ref': 'false',
    'job-summary': 'false',
    retry: 'true',
    'retry-count': '3',
  };
  for (const [input, name] of [
    ['endpoint', 'BENCH_ENDPOINT'],
    ['region', 'BENCH_REGION'],
    ['provider', 'BENCH_PROVIDER'],
    ['access-key', 'BENCH_ACCESS_KEY'],
    ['secret-key', 'BENCH_SECRET_KEY'],
  ]) {
    if (env(name) !== '') {
      inputs[input] = env(name);
    }
  }
  return inputs;
}

/** Runs one bundle with the given inputs and returns its metrics line. */
function runBundle(bundle: 'save-only' | 'restore-only', inputs: Record<string, string>): Metrics {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  const metricsFile = path.join(scratch, 'metrics.jsonl');
  const stepEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_OUTPUT: path.join(scratch, 'output.txt'),
    GITHUB_STATE: path.join(scratch, 'state.txt'),
    GITHUB_STEP_SUMMARY: path.join(scratch, 'summary.md'),
    GITHUB_WORKSPACE: workspace,
  };
  for (const file of ['output.txt', 'state.txt', 'summary.md']) {
    fs.writeFileSync(path.join(scratch, file), '');
  }
  for (const [name, value] of Object.entries({ ...inputs, 'metrics-file': metricsFile })) {
    stepEnv[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = value;
  }
  const result = spawnSync(process.execPath, [path.join(REPO, 'dist', bundle, 'index.js')], {
    env: stepEnv,
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 64 * MiB,
  });
  const lines = fs.existsSync(metricsFile) ? fs.readFileSync(metricsFile, 'utf8').trim() : '';
  fs.rmSync(scratch, { recursive: true, force: true });
  if (result.status !== 0 || lines === '') {
    throw new Error(
      `${bundle} exited with ${result.status}\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-2000)}`
    );
  }
  const metrics = JSON.parse(lines.split('\n').pop() as string) as Metrics;
  if (metrics.outcome !== 'saved' && metrics.outcome !== 'hit') {
    throw new Error(
      `${bundle} finished with outcome ${metrics.outcome}\n${result.stdout.slice(-4000)}`
    );
  }
  return metrics;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};
const rate = (bytes: number, ms: number): string => (bytes / MiB / (ms / 1000)).toFixed(0);

async function cleanup(): Promise<void> {
  const inputs = providerInputs();
  const client = new S3Client({
    region: inputs.region || 'auto',
    endpoint: inputs.endpoint || undefined,
    forcePathStyle: inputs.endpoint !== undefined,
    credentials:
      inputs['access-key'] && inputs['secret-key']
        ? { accessKeyId: inputs['access-key'], secretAccessKey: inputs['secret-key'] }
        : undefined,
  });
  const scope = `${env('GITHUB_REPOSITORY')}/${prefix}`;
  let token: string | undefined;
  let deleted = 0;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: inputs.bucket, Prefix: scope, ContinuationToken: token })
    );
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key as string }));
    if (keys.length > 0) {
      await client.send(
        new DeleteObjectsCommand({ Bucket: inputs.bucket, Delete: { Objects: keys } })
      );
      deleted += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  client.destroy();
  console.log(`Deleted ${deleted} benchmark object(s) under ${scope}`);
}

async function main(): Promise<void> {
  if (env('BENCH_BUCKET') === '') {
    throw new Error('BENCH_BUCKET is required');
  }
  const base = providerInputs();
  const samples: Sample[] = [];
  console.log(
    `Payload: ${sizeMb} MiB of random data in ${payloadDir}; ${repeats} repeat(s) per config`
  );
  const expected = writePayload();

  try {
    let defaultKey = '';
    for (const upload of UPLOADS) {
      const inputs = {
        'upload-concurrency': String(upload.concurrency),
        'upload-chunk-size': String(upload.chunkSize),
        streaming: String(upload.streaming),
      };
      const sample: Sample = {
        kind: 'save',
        config: upload.name,
        inputs,
        bytes: 0,
        transferMs: [],
        totalMs: [],
      };
      for (let i = 0; i < repeats; i++) {
        const key = `bench-${runId}-${upload.concurrency}-${upload.chunkSize}-${upload.streaming}-${i}`;
        const m = runBundle('save-only', { ...base, ...inputs, key, path: 'bench-payload' });
        sample.bytes = m.bytes;
        sample.transferMs.push(m.transferDurationMs ?? m.durationMs);
        sample.totalMs.push(m.durationMs);
        console.log(
          `save   ${upload.name.padEnd(36)} ${m.transferDurationMs} ms transfer, ${m.durationMs} ms total`
        );
        if (upload.name.startsWith('defaults') && i === 0) {
          defaultKey = key;
        }
      }
      samples.push(sample);
    }

    for (const download of DOWNLOADS) {
      const inputs = {
        'download-concurrency': String(download.concurrency),
        'download-chunk-size': String(download.chunkSize),
        streaming: String(download.streaming),
      };
      const sample: Sample = {
        kind: 'restore',
        config: download.name,
        inputs,
        bytes: 0,
        transferMs: [],
        totalMs: [],
      };
      for (let i = 0; i < repeats; i++) {
        fs.rmSync(payloadDir, { recursive: true, force: true });
        const m = runBundle('restore-only', {
          ...base,
          ...inputs,
          key: defaultKey,
          path: 'bench-payload',
          'fail-on-cache-miss': 'true',
        });
        const actual = digestPayload();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(`Restored payload differs from the saved one for "${download.name}"`);
        }
        sample.bytes = m.bytes;
        sample.downloadParts = m.downloadParts;
        sample.transferMs.push(m.transferDurationMs ?? m.durationMs);
        sample.totalMs.push(m.durationMs);
        console.log(
          `restore ${download.name.padEnd(36)} ${m.transferDurationMs} ms transfer, ${m.durationMs} ms total, ${m.downloadParts} part(s)`
        );
      }
      samples.push(sample);
    }
  } finally {
    fs.rmSync(payloadDir, { recursive: true, force: true });
    await cleanup().catch((err) =>
      console.log(`::warning::Benchmark cleanup failed: ${String(err)}`)
    );
  }

  const archiveMb = (samples[0].bytes / MiB).toFixed(0);
  const runner = `${os.platform()} ${os.arch()}, ${os.cpus().length} CPUs, node ${process.version}`;
  const lines: string[] = [];
  lines.push(`### Transfer benchmark: ${label}, ${archiveMb} MiB archive, median of ${repeats}`);
  lines.push('');
  lines.push(`Runner: ${runner}.`);
  lines.push('');
  lines.push('| Direction | Configuration | Transfer | MiB/s | Whole step |');
  lines.push('| --- | --- | ---: | ---: | ---: |');
  for (const s of samples) {
    const t = median(s.transferMs);
    const note =
      s.kind === 'restore' && s.inputs.streaming === 'true' ? ' (download + extract)' : '';
    lines.push(
      `| ${s.kind} | ${s.config} | ${(t / 1000).toFixed(1)} s${note} | ${rate(s.bytes, t)} | ${(median(s.totalMs) / 1000).toFixed(1)} s |`
    );
  }
  const markdown = lines.join('\n');
  console.log(`\n${markdown}\n`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'benchmark-results.md'), `${markdown}\n`);
  fs.writeFileSync(
    path.join(outDir, 'benchmark-results.json'),
    JSON.stringify(
      { label, sizeMb, archiveBytes: samples[0].bytes, repeats, runner, samples },
      null,
      2
    )
  );
  if (env('GITHUB_STEP_SUMMARY') !== '') {
    fs.appendFileSync(env('GITHUB_STEP_SUMMARY'), `${markdown}\n\n`);
  }
}

await main();
