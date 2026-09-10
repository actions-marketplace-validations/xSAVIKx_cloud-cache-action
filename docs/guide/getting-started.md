# Getting Started

**Cloud Cache Action** allows you to store and retrieve GitHub Actions cache bundles using any S3-compatible cloud or self-hosted object storage service.

It is designed as a drop-in replacement for `actions/cache@v4-v6`, keeping your CI/CD workflows lightning fast while bypassing GitHub's 10GB default cache quotas and egress fees.

## Quickstart

Add the following step to your GitHub Actions workflow:

```yaml
- name: Cache dependencies to S3
  uses: serhiichuk/cloud-cache-action@v1
  with:
    bucket: my-ci-cache-bucket
    endpoint: https://<account_id>.r2.cloudflarestorage.com # Or AWS, GCS, B2, MinIO, etc.
    access-key: ${{ secrets.S3_ACCESS_KEY }}
    secret-key: ${{ secrets.S3_SECRET_KEY }}
    path: |
      ~/.npm
      node_modules
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
```

## How It Works

1. **Restore Phase (Pre/Main)**:
   - Connects to your S3 bucket using modern `@aws-sdk/client-s3`.
   - Checks if an exact match exists for the `key` parameter.
   - If not found, evaluates `restore-keys` in order and downloads the most recently updated matching archive.
   - Decompresses the archive using `zstd` (or `gzip` fallback) directly into your workspace.
   - Sets outputs (`cache-hit`, `cache-primary-key`, `cache-matched-key`, `cache-size`, `cache-storage-provider`, `cache-s3-key`).

2. **Save Phase (Post)**:
   - If `read-only: true` or if an exact key match occurred during restore, saving is automatically skipped.
   - Otherwise, archives the specified `path` directories using multi-threaded `zstd` compression.
   - Streams the compressed archive to your S3 bucket using multipart uploads via `@aws-sdk/lib-storage`.
   - Emits diagnostics and completes cleanly without breaking the build on non-fatal network interruptions.

## Standalone Restore and Save Actions

Just like `actions/cache/restore` and `actions/cache/save`, you can invoke restore and save as independent steps:

### Restore Only

```yaml
- name: Restore cache
  id: restore-step
  uses: serhiichuk/cloud-cache-action/restore@v1
  with:
    bucket: my-ci-cache-bucket
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: build/
```

### Save Only

```yaml
- name: Save cache
  uses: serhiichuk/cloud-cache-action/save@v1
  with:
    bucket: my-ci-cache-bucket
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: build/
```
