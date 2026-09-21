---
title: Transfer Performance
---

# Transfer Performance

The `download-concurrency`, `download-chunk-size`, `upload-concurrency` and `upload-chunk-size`
inputs decide how many connections a transfer uses and how much each request carries. This page
shows what they do to a real cache on a GitHub-hosted runner, so you can pick values for your
provider instead of guessing. See [Parallel Transfers](https://github.com/xSAVIKx/cloud-cache-action#parallel-transfers)
in the README for how the inputs work.

## How the numbers were measured

The [Transfer benchmark](https://github.com/xSAVIKx/cloud-cache-action/actions/workflows/benchmark.yml)
workflow (`tests/ci/benchmark.ts`) saves a 512 MiB archive of random bytes, which does not
compress, with several upload settings, then restores it with several download settings, and
verifies every restored file. Each configuration ran twice and the tables show the median.

- Runner: `ubuntu-latest` (4 vCPU), Node 24.20.0, run
  [35653417989](https://github.com/xSAVIKx/cloud-cache-action/actions/runs/35653417989) on
  2026-09-21.
- **Transfer** is the S3 transfer alone (`cache-transfer-duration-ms`). In streaming mode the
  archive is extracted or compressed as it moves, so the same figure covers download plus extract
  or tar plus upload.
- **Whole step** is the full step (`cache-restore-duration-ms` or `cache-save-duration-ms`),
  including tar, compression, the sha256 check and, on streaming saves, the metadata copy.
- Absolute numbers depend on the bucket region, the runner's location and the time of day. Your
  numbers will differ, but the ratios between rows are what to look at.

## Restore

| Configuration | Cloudflare R2 | Amazon S3 | Google Cloud Storage |
| --- | ---: | ---: | ---: |
| `download-concurrency: 1` (single request) | 13.2 s, 39 MiB/s | 6.2 s, 83 MiB/s | 12.5 s, 41 MiB/s |
| **Default: 8 × 4 MiB** | 3.9 s, 130 MiB/s | 2.6 s, 201 MiB/s | 9.6 s, 53 MiB/s |
| 8 × 16 MiB | 2.4 s, 215 MiB/s | 1.8 s, 289 MiB/s | 3.7 s, 137 MiB/s |
| 16 × 8 MiB | 2.5 s, 209 MiB/s | 1.9 s, 274 MiB/s | 3.1 s, 163 MiB/s |
| 32 × 16 MiB | 2.1 s, 249 MiB/s | 1.9 s, 273 MiB/s | 2.3 s, 218 MiB/s |
| `streaming: true`, single request | 10.5 s, 49 MiB/s | 5.4 s, 95 MiB/s | 9.4 s, 55 MiB/s |
| `streaming: true`, default 8 × 4 MiB | 5.7 s, 90 MiB/s | 3.7 s, 138 MiB/s | 9.5 s, 54 MiB/s |
| `streaming: true`, 16 × 8 MiB | 3.9 s, 132 MiB/s | 3.5 s, 145 MiB/s | 3.7 s, 137 MiB/s |

What the table says:

- **The parallel download is the big win.** Against a single request, the default 8 × 4 MiB cuts
  the transfer 3.4× on R2 and 2.4× on S3.
- **4 MiB parts are small for GCS.** Its per-request latency dominates, so the default only gains
  1.3× there. Raising `download-chunk-size` to 8 or 16 MiB gives another 2.6× to 3× on GCS and
  1.4× to 1.6× on R2 and S3.
- **Past 16 connections the gains flatten** on S3 and R2. Only GCS keeps improving up to 32 × 16
  MiB.
- **Streaming restores are slower than file mode here** because one `tar` process must consume the
  bytes in order while the parallel parts wait. Streaming still saves the disk space of the
  temporary archive, and its whole-step time is close to file mode's once the chunk size is raised.

## Save

| Configuration | Cloudflare R2 | Amazon S3 | Google Cloud Storage |
| --- | ---: | ---: | ---: |
| v1.3 defaults: 4 × 10 MiB | 17.1 s, 30 MiB/s | 6.6 s, 77 MiB/s | 14.1 s, 36 MiB/s |
| **Default: 8 × 64 MiB** | 7.7 s, 67 MiB/s | 2.5 s, 204 MiB/s | 3.7 s, 139 MiB/s |
| 16 × 32 MiB | 4.9 s, 105 MiB/s | 2.7 s, 187 MiB/s | 3.0 s, 169 MiB/s |
| `streaming: true`, default 8 × 64 MiB | 10.9 s, 47 MiB/s | 3.5 s, 147 MiB/s | 4.1 s, 125 MiB/s |

What the table says:

- **The new upload defaults are 2.2× to 3.8× faster than v1.3's** 4 × 10 MiB on every provider.
- **R2 benefits from more connections.** 16 × 32 MiB is another 1.6× faster there, and holds the
  same 512 MiB of parts in memory as the default.
- **Streaming saves pay for the metadata copy.** On S3 the whole step took 10.9 s against 3.5 s of
  transfer, because the sha256 is attached by copying the 512 MiB object onto itself after the
  upload. R2 and GCS copy faster. File mode sends the checksum with the upload and has no copy.

## Recommended settings

The defaults are the `actions/cache` values and are a safe starting point on every provider. When
transfer time matters, these settings measured best:

```yaml
# Fastest restores on every provider measured; 128 MiB of parts in memory in streaming mode.
    download-concurrency: 16
    download-chunk-size: 8388608     # 8 MiB

# Google Cloud Storage: larger parts matter most.
    download-concurrency: 32
    download-chunk-size: 16777216    # 16 MiB

# Cloudflare R2 saves: more, smaller parts.
    upload-concurrency: 16
    upload-chunk-size: 33554432      # 32 MiB

# Small self-hosted runner: keep memory low at the cost of speed.
    download-concurrency: 4
    download-chunk-size: 4194304
    upload-concurrency: 4
    upload-chunk-size: 10485760
```

Memory per transfer is concurrency × chunk size: 64 MiB for the default download and 512 MiB for
the default upload.

## Running the benchmark yourself

Trigger the **Transfer benchmark** workflow from the Actions tab, or:

```sh
gh workflow run benchmark.yml -f size-mb=1024 -f repeats=3
```

It runs one job per provider whose secrets are configured (the same secrets as the live provider
suites), writes a table per provider to the job summary, uploads `benchmark-results.md` and
`benchmark-results.json` as `benchmark-<provider>` artifacts, and deletes the objects it created.
