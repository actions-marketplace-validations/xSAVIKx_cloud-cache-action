# Cloud Cache Action

[![CI Tests](https://github.com/xSAVIKx/cloud-cache-action/actions/workflows/test.yml/badge.svg)](https://github.com/xSAVIKx/cloud-cache-action/actions/workflows/test.yml)
[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue.svg)](https://xsavikx.github.io/cloud-cache-action/)
[![Node Runtime](https://img.shields.io/badge/node-24-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Author](https://img.shields.io/badge/Author-serhiichuk.dev-black)](https://serhiichuk.dev)

A modern, high-performance GitHub Action for saving and restoring cache bundles directly to any S3-compatible cloud or self-hosted object storage with **1:1 `actions/cache` (v4–v6) parity**.

Created and maintained by [Yurii Serhiichuk](https://serhiichuk.dev).

---

## Features

- **1:1 Parity with `actions/cache` (v4–v6)**: Drop-in replacement for official inputs (`key`, `path`, `restore-keys`, `lookup-only`, `fail-on-cache-miss`, `enableCrossOsArchive`, `read-only`, `save-always`) and outputs (`cache-hit`, `cache-primary-key`, `cache-matched-key`).
- **No Deprecation Warnings**: Built natively for modern GitHub Actions runners (`runs: using: 'node24'`).
- **Universal S3 Compatibility**: First-class support for:
  - **AWS S3** (IAM static credentials or OIDC `aws-actions/configure-aws-credentials`)
  - **Cloudflare R2** (Zero egress caching)
  - **Google Cloud Storage (GCS)** (HMAC interoperability)
  - **Backblaze B2**
  - **Fastly Object Storage**
  - **Garage S3** (Lightweight self-hosted S3)
  - **SeaweedFS S3**
  - **MinIO / LocalStack / Ceph**
- **Smart Provider Auto-Detection**: Automatically determines optimal regions and path-style addressing from your endpoint URL.
- **Custom S3 Key & Environment Templating**: Default pattern `${GITHUB_REPOSITORY}/${prefix}${key}/${archive_filename}` with full override capability and support for dynamic environment variables (`${RUNNER_OS}`, `${GITHUB_JOB}`, `${WORKLOAD_TYPE}`).
- **Safe Cross-Platform Keys**: Guarantees standard POSIX forward slashes (`/`) in object storage across Linux, macOS, and Windows runners (fixing legacy backslash bugs).
- **Multi-Threaded `zstd` Compression**: Lightning-fast archiving with fallback to `gzip`.
- **Dual Caching (Multi-Tier)**: Optionally cache across both remote S3 and GitHub Actions Cache simultaneously with configurable priority (`s3-first` or `github-first`) and automatic backfill synchronization.
- **Standalone Sub-Actions**: Includes `cloud-cache-action/restore` and `cloud-cache-action/save` for decoupled cache stages.
- **Resilient**: Automatic exponential backoff retries on transient network errors.

---

## Quick Usage

```yaml
- name: Cache dependencies to S3
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache-bucket
    endpoint: https://<account_id>.r2.cloudflarestorage.com # Or AWS, GCS, B2, MinIO
    access-key: ${{ secrets.S3_ACCESS_KEY }}
    secret-key: ${{ secrets.S3_SECRET_KEY }}
    path: |
      ~/.npm
      node_modules
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
```

---

## Documentation

Full documentation, provider guides, and advanced configurations are available at:

👉 **[https://xsavikx.github.io/cloud-cache-action/](https://xsavikx.github.io/cloud-cache-action/)**

---

## Supported Providers & Examples

### Cloudflare R2

Zero egress fees for CI caches:

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: ci-cache
    endpoint: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com
    access-key: ${{ secrets.R2_ACCESS_KEY }}
    secret-key: ${{ secrets.R2_SECRET_KEY }}
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: ~/.cache
```

### AWS S3 (with OIDC)

```yaml
- name: Configure AWS Credentials via OIDC
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsCacheRole
    aws-region: us-east-1

- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-aws-cache-bucket
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: target/
```

### Google Cloud Storage (GCS)

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-gcs-cache-bucket
    endpoint: https://storage.googleapis.com
    access-key: ${{ secrets.GCS_HMAC_ACCESS_ID }}
    secret-key: ${{ secrets.GCS_HMAC_SECRET }}
    key: ${{ runner.os }}-gradle-${{ hashFiles('**/*.gradle*') }}
    path: ~/.gradle/caches
```

### Backblaze B2

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-b2-cache-bucket
    endpoint: https://s3.us-west-004.backblazeb2.com
    access-key: ${{ secrets.B2_KEY_ID }}
    secret-key: ${{ secrets.B2_APPLICATION_KEY }}
    key: ${{ runner.os }}-maven-${{ hashFiles('**/pom.xml') }}
    path: ~/.m2/repository
```

### Fastly Object Storage

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-fastly-cache
    endpoint: https://object.us-east-1.fastlystorage.com
    access-key: ${{ secrets.FASTLY_ACCESS_KEY }}
    secret-key: ${{ secrets.FASTLY_SECRET_KEY }}
    key: ${{ runner.os }}-cargo-${{ hashFiles('**/Cargo.lock') }}
    path: target/
```

### Self-Hosted: Garage & SeaweedFS

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: ci-cache
    endpoint: http://garage.internal:3900 # or http://seaweedfs.internal:8333
    provider: garage # or seaweedfs
    access-key: ${{ secrets.GARAGE_ACCESS_KEY }}
    secret-key: ${{ secrets.GARAGE_SECRET_KEY }}
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: build/
```

### Dual Caching (Lightweight GitHub Runner $\to$ Heavy Remote Cloud Build)

Cache across **both** S3 and GitHub Actions Cache simultaneously. In this pattern, lightweight GitHub-hosted runners assemble `node_modules`, and heavy remote AWS/GCP machines pull directly from S3 at line-rate VPC speeds:

```yaml
# Job 1: Lightweight GitHub-hosted runner installs & caches dependencies
- name: Prepare node_modules
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache
    endpoint: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com
    access-key: ${{ secrets.R2_ACCESS_KEY }}
    secret-key: ${{ secrets.R2_SECRET_KEY }}
    dual-cache: true
    restore-priority: github-first   # Fast local cache on GitHub-hosted runner
    dual-cache-strategy: backfill    # Populates S3 bucket so remote runners can access it
    key: ${{ runner.os }}-node-modules-${{ hashFiles('**/package-lock.json') }}
    path: node_modules

# Job 2: Remote AWS/GCP self-hosted runner building Docker/native binaries
- name: Restore node_modules directly from S3
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache
    endpoint: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com
    access-key: ${{ secrets.R2_ACCESS_KEY }}
    secret-key: ${{ secrets.R2_SECRET_KEY }}
    dual-cache: true
    restore-priority: s3-first       # Direct VPC speed, bypasses GitHub cache latency
    read-only: true                  # Fast restore-only for build job
    key: ${{ runner.os }}-node-modules-${{ hashFiles('**/package-lock.json') }}
    path: node_modules
```

---

## Inputs

| Input | Required | Default | Description |
|---|:---:|:---:|---|
| `bucket` | **Yes** | — | Name of the S3 bucket |
| `key` | **Yes** | — | Explicit key for restoring and saving cache |
| `path` | **Yes** | — | Multiline list of paths or files to cache |
| `restore-keys` | No | — | Multiline string of prefix keys for fallback matching |
| `endpoint` | No | Auto/AWS | Custom S3 endpoint URL |
| `region` | No | Auto/`us-east-1` | AWS or S3 provider region |
| `provider` | No | Auto | Preset: `aws`, `r2`, `gcs`, `b2`, `fastly`, `garage`, `seaweedfs`, `minio` |
| `access-key` / `accessKey` | No | `AWS_ACCESS_KEY_ID` | S3 Access Key ID |
| `secret-key` / `secretKey` | No | `AWS_SECRET_ACCESS_KEY` | S3 Secret Access Key |
| `session-token` / `sessionToken` | No | `AWS_SESSION_TOKEN` | S3 Session Token |
| `force-path-style` | No | Auto | Force path-style S3 URLs |
| `prefix` | No | `""` | Subfolder prefix path inside bucket |
| `s3-key-pattern` | No | `${GITHUB_REPOSITORY}/${prefix}${key}/${archive_filename}` | Custom S3 key template pattern (supports `${ENV_VARS}`) |
| `scoped-to-repository` | No | `true` | Prefix bucket cache paths with repository name |
| `lookup-only` | No | `false` | Check existence without downloading |
| `fail-on-cache-miss` | No | `false` | Fail workflow if cache is not found |
| `enableCrossOsArchive`| No | `false` | Allow Windows runners to save/restore cross-OS caches |
| `read-only` | No | `false` | Restore cache but never save in post step |
| `save-always` | No | `false` | Run post-save even if prior steps failed |
| `retry` | No | `true` | Enable exponential backoff retries on S3 operations |
| `retry-count` | No | `3` | Maximum number of S3 retries |
| `use-fallback` | No | `false` | Fallback to GitHub Actions cache service if S3 fails |
| `dual-cache` | No | `false` | Cache to both S3 and GitHub Actions Cache simultaneously |
| `restore-priority` | No | `s3-first` | Cache source to query first: `s3-first` or `github-first` |
| `dual-cache-strategy` | No | `backfill` | Sync strategy: `backfill` (sync missing tier), `independent`, `skip-on-hit` |
| `dual-cache-strict` | No | `false` | Fail step if either tier encounters an error |

---

## Outputs

- `cache-hit`: `'true'` if an exact match was found for the primary key; `'false'` otherwise.
- `cache-primary-key`: The evaluated primary cache key.
- `cache-matched-key`: Key that was matched and restored.
- `cache-size`: Archive size in bytes.
- `cache-storage-provider`: Resolved storage provider (e.g. `r2`, `gcs`, `aws`).
- `cache-s3-key`: Full S3 object key inside the bucket.
- `cache-etag`: ETag checksum of the archive in S3.
- `cache-hit-source`: The tier that serviced the hit: `s3`, `github`, or `none`.
- `cache-saved-sources`: Tiers successfully saved to: `s3`, `github`, or `s3,github`.

---

## Sub-Actions

- **Restore Only**: `uses: xSAVIKx/cloud-cache-action/restore@v1`
- **Save Only**: `uses: xSAVIKx/cloud-cache-action/save@v1`

---

## Development & Local Testing

```bash
# Install dependencies
npm install

# Run unit and contract test suites
npm test

# Spin up local Garage or SeaweedFS for integration tests
docker compose -f docker-compose.test.yml up -d garage

# Build distribution bundles (dist/)
npm run build

# Build documentation site
npm run docs:build
```

---

## License & Attribution

Distributed under the [MIT License](LICENSE).

Authored by **[Yurii Serhiichuk](https://serhiichuk.dev)**.
