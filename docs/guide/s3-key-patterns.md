# S3 Key Templating & Overrides

Cloud Cache Action gives you complete control over where and how cache archives are named and organized in your storage bucket.

## Default Key Pattern

By default, the S3 key is constructed using:

```text
${GITHUB_REPOSITORY}/${prefix}${key}/${archive_filename}
```

For example, for repository `my-org/my-project` with primary key `linux-node-18-a1b2c3`, the resulting object in the bucket will be:

```text
my-org/my-project/linux-node-18-a1b2c3/cache.tar.zst
```

## Available Template Placeholders

### Special Placeholders

| Variable               | Description                                       | Example                           |
| ---------------------- | ------------------------------------------------- | --------------------------------- |
| `${GITHUB_REPOSITORY}` | Repository name in `owner/repo` format            | `xSAVIKx/cloud-cache-action`      |
| `${prefix}`            | Subfolder prefix with trailing slash if non-empty | `frontend/`                       |
| `${key}`               | The primary or matched cache key                  | `linux-node-a1b2c3`               |
| `${archive_filename}`  | Compressed archive filename                       | `cache.tar.zst` or `cache.tar.gz` |

### Environment Variables

You can also reference **any environment variable** using `${VAR_NAME}`, `$VAR_NAME`, or `${env.VAR_NAME}`. This enables isolation per workload, job, matrix runner, or workflow run:

| Variable             | Description                           | Example Value               |
| -------------------- | ------------------------------------- | --------------------------- |
| `${RUNNER_OS}`       | Runner operating system               | `Linux`, `Windows`, `macOS` |
| `${GITHUB_JOB}`      | Current job ID in the workflow        | `build-frontend`            |
| `${GITHUB_RUN_ID}`   | Unique ID of the workflow run         | `1234567890`                |
| `${GITHUB_REF_NAME}` | Branch or tag name                    | `main`, `feature-auth`      |
| `${CUSTOM_WORKLOAD}` | Any user-defined environment variable | `api-service`               |

## Common Configuration Patterns

### 1. Custom Prefix Within Repository

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: ci-caches
    prefix: web-app
    key: ${{ runner.os }}-node-${{ hashFiles('yarn.lock') }}
    path: node_modules
```

Object key: `my-org/my-repo/web-app/linux-node-12345/cache.tar.zst`

### 2. Disabling Repository Scoping (Global Shared Cache)

If multiple repositories share the exact same pre-built toolchains or caches across an organization:

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: shared-org-cache
    scoped-to-repository: false
    key: global-rust-toolchain-v1
    path: ~/.cargo
```

Object key: `global-rust-toolchain-v1/cache.tar.zst`

### 3. Fully Custom S3 Key Pattern

You can define any pattern using `s3-key-pattern`:

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-bucket
    s3-key-pattern: 'builds/${GITHUB_REPOSITORY}/${prefix}${key}.tar.zst'
    prefix: release-v1/
    key: app-bundle
    path: dist/
```

Object key: `builds/my-org/my-repo/release-v1/app-bundle.tar.zst`

### 4. Per-Workload / Per-Job Isolated Cache

You can isolate caches across parallel matrix jobs, workloads, or workflow runs using environment variables:

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  env:
    WORKLOAD_TYPE: backend-api
  with:
    bucket: my-bucket
    s3-key-pattern: '${GITHUB_REPOSITORY}/${RUNNER_OS}/${WORKLOAD_TYPE}/${key}/${archive_filename}'
    key: ${{ runner.os }}-deps-${{ hashFiles('go.sum') }}
    path: ~/go/pkg/mod
```

Object key: `my-org/my-repo/Linux/backend-api/Linux-deps-abc123/cache.tar.zst`

> [!NOTE]
> Regardless of whether the runner is running on Windows, Linux, or macOS, all S3 keys are guaranteed to be normalized with standard POSIX forward slashes (`/`), avoiding invalid backslashes in object storage.
