# Getting Started

**Cloud Cache Action** allows you to store and retrieve GitHub Actions cache bundles using any S3-compatible cloud or self-hosted object storage service.

It is designed as a drop-in replacement for `actions/cache@v4-v6`, keeping your CI/CD workflows lightning fast while bypassing GitHub's 10GB default cache quotas and egress fees.

## Quickstart

Add the following step to your GitHub Actions workflow:

```yaml
- name: Cache dependencies to S3
  uses: xSAVIKx/cloud-cache-action@v1
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

## Paths and Exclusions

`path` accepts files, directories, globs, `~` and `!` exclusions, one per line.

- **Exclusions only remove what the include patterns matched**, as in `actions/cache`. `path: logs` with `!logs/debug.txt` still caches the whole `logs` directory, because the directory itself is the match. To leave one file out, match the files instead:

  ```yaml
  path: |
    logs/*
    !logs/debug.txt
  ```

- **Symbolic links are not followed while matching.** A pattern that wildcards through a symlinked directory, such as `linked-dir/*` where `linked-dir` is a symlink, matches nothing. A symlink that a pattern matches is archived as a link, not as the files it points to.

### Symlinks

Symlinks are archived as links, never followed and re-created as copies. On Windows, `windows-latest` runners use Git's bundled GNU `tar`, which this action runs with `MSYS=winsymlinks:nativestrict` (the same setting `actions/cache` uses) so that restored links come back as native NTFS symlinks rather than plain-text stand-ins. GitHub-hosted Windows runners allow creating these without extra privileges.

## How It Works

1. **Restore Phase (Pre/Main)**:
   - Connects to your S3 bucket using modern `@aws-sdk/client-s3`.
   - Checks if an exact match exists for the `key` parameter.
   - If not found, evaluates `restore-keys` in order and downloads the most recently updated matching archive.
   - Verifies the archive's sha256 checksum, when the object carries one, before extracting it; a mismatch is logged as a warning and counts as a cache miss (with `dual-cache: true` and `dual-cache-strict: true`, it fails the step).
   - With `streaming: true`, extracts the archive as it downloads instead, verifying the checksum at the end: a network or `tar` failure mid-stream, or a checksum mismatch, becomes a cache miss with the workspace possibly partly extracted, and there is no whole-download retry as there is in the default file mode.
   - Decompresses the archive using `zstd` (or `gzip` fallback) directly into your workspace.
   - Sets outputs (`cache-hit`, `cache-primary-key`, `cache-matched-key`, `cache-size`, `cache-storage-provider`, `cache-s3-key`).
   - Writes a job summary table with the key, hit status, source, size and duration, unless `job-summary: false`.

2. **Save Phase (Post)**:
   - If `read-only: true` or if an exact key match occurred during restore, saving is automatically skipped.
   - Checks whether another job already saved the same object first; if so, keeps that job's cache instead of overwriting it. The upload itself is a conditional create, so two saves racing for the same key cannot overwrite each other on providers that enforce `If-None-Match` (verified on AWS S3, MinIO and SeaweedFS); providers that ignore it (verified: Garage; reportedly Google Cloud Storage's S3 interoperability) keep last-writer-wins.
   - Otherwise, archives the specified `path` directories using multi-threaded `zstd` compression.
   - Streams the compressed archive to your S3 bucket using multipart uploads via `@aws-sdk/lib-storage`, tagged with a sha256 checksum for later integrity verification.
   - Emits diagnostics and completes cleanly without breaking the build on non-fatal network interruptions.
   - Writes a job summary table with the key, saved-to tiers, size and duration, unless `job-summary: false`.

Cache archives are never deleted automatically; see [Pruning Caches](./pruning.md) for a
scheduled cleanup sub-action.

## Standalone Restore and Save Actions

Just like `actions/cache/restore` and `actions/cache/save`, you can invoke restore and save as independent steps:

### Restore Only

```yaml
- name: Restore cache
  id: restore-step
  uses: xSAVIKx/cloud-cache-action/restore@v1
  with:
    bucket: my-ci-cache-bucket
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: build/
```

### Save Only

```yaml
- name: Save cache
  uses: xSAVIKx/cloud-cache-action/save@v1
  with:
    bucket: my-ci-cache-bucket
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: build/
```

### Action Metadata Definitions

You can inspect the full action specification files directly in the repository:

- **Unified Action**: [`action.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/action.yml)
- **Dedicated Restore Action**: [`restore/action.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/restore/action.yml)
- **Dedicated Save Action**: [`save/action.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/save/action.yml)

::: details `action.yml` (Click to view unified action definition)
<<< ../../action.yml{yaml}
:::

::: details `restore/action.yml` (Click to view restore action definition)
<<< ../../restore/action.yml{yaml}
:::

::: details `save/action.yml` (Click to view save action definition)
<<< ../../save/action.yml{yaml}
:::

