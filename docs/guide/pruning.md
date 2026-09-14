# Pruning Caches

Object storage has no built-in cache eviction like GitHub's 10 GB-per-repository limit: whatever
you save to S3 stays there until something deletes it. `cloud-cache-action/prune` is a standalone
sub-action that deletes cache archives older than a given age from any S3-compatible bucket, so you
can run it on a schedule instead of relying only on a bucket lifecycle rule.

## Usage

Run it in its own scheduled workflow. **Start with `dry-run: true`** so you can read the logged
output before anything is actually deleted, then flip it to `false` once it looks right:

```yaml
name: Prune old caches

on:
  schedule:
    - cron: '0 3 * * 0' # Every Sunday at 03:00 UTC

jobs:
  prune:
    runs-on: ubuntu-latest
    steps:
      - uses: xSAVIKx/cloud-cache-action/prune@v1
        with:
          bucket: my-ci-cache-bucket
          endpoint: https://<account_id>.r2.cloudflarestorage.com # Or AWS, GCS, B2, MinIO, etc.
          access-key: ${{ secrets.S3_ACCESS_KEY }}
          secret-key: ${{ secrets.S3_SECRET_KEY }}
          older-than-days: 30
          dry-run: true # Flip to false once the logged output looks right.
```

Each candidate is logged at info level with its size and age (capped at 200 lines, followed by a
totals line), so a dry run tells you exactly what a real run would delete.

## Inputs

The prune action shares its storage inputs with the main action, plus three inputs of its own:

| Input                             | Required |          Default          | Description                                                                 |
| ---------------------------------- | :------: | :------------------------: | ---------------------------------------------------------------------------- |
| `bucket`                           | **Yes**  |             —              | Name of the S3 bucket                                                        |
| `older-than-days`                  | **Yes**  |             —              | Delete cache archives whose last-modified time is older than this many days |
| `ref`                               |    No    |     _(every ref)_          | Prune only caches under this full Git ref (`refs/heads/main`); empty means every ref |
| `dry-run`                           |    No    |          `false`           | List cache archives that would be pruned without deleting anything          |
| `endpoint`                         |    No    |          Auto/AWS          | Custom S3-compatible endpoint URL                                           |
| `region`                           |    No    |      Auto/`us-east-1`      | AWS or S3 provider region                                                    |
| `provider`                         |    No    |            Auto            | Preset: `aws`, `r2`, `gcs`, `b2`, `fastly`, `garage`, `seaweedfs`, `minio`  |
| `access-key` / `accessKey`         |    No    |    `AWS_ACCESS_KEY_ID`     | S3 Access Key ID                                                             |
| `secret-key` / `secretKey`         |    No    |  `AWS_SECRET_ACCESS_KEY`   | S3 Secret Access Key                                                         |
| `session-token` / `sessionToken`   |    No    |    `AWS_SESSION_TOKEN`     | S3 Session Token                                                             |
| `force-path-style`                 |    No    |            Auto            | Force path-style S3 URLs                                                    |
| `prefix`                           |    No    |            `""`            | Subfolder prefix path inside the bucket                                     |
| `s3-key-pattern`                   |    No    | same default as the main action | Template for the S3 object key (see [S3 Key Templating](./s3-key-patterns.md)) |
| `scoped-to-repository`             |    No    |           `true`           | Whether to prefix bucket cache paths with `GITHUB_REPOSITORY`               |
| `scoped-to-ref`                    |    No    |           `true`           | Whether cache keys include the Git ref; set `false` to prune caches saved with `scoped-to-ref: false` |
| `retry`                            |    No    |           `true`           | Enable exponential backoff retries on S3 operations                        |
| `retry-count`                      |    No    |            `3`              | Maximum number of S3 retries                                                |

An invalid `older-than-days` (not a positive integer) or an unrecognized `dry-run` value (anything
other than `true`, `True`, `TRUE`, `false`, `False` or `FALSE`) fails the step immediately, rather
than silently falling back to a default — a typo like `dry-run: Flase` must never turn into a real
deletion.

## Outputs

| Output          | Description                                                                    |
| ---------------- | ------------------------------------------------------------------------------- |
| `pruned-count`   | The number of cache archives pruned (or that would be pruned in a dry run)      |
| `pruned-bytes`   | The total size in bytes of the pruned cache archives                           |
| `kept-count`     | The number of cache archives that matched the scope but were not old enough    |

## What gets pruned

Prune lists objects under the fixed start of your `s3-key-pattern` and only treats an object as a
candidate when its **whole key** matches the pattern: this repository, the configured prefix, the
given ref (or any full ref such as `refs%2Fheads%2Fmain` when `ref` is empty), any cache key, any
version, and either archive filename the action produces (`cache.tar.zst` or `cache.tar.gz`).
Objects that are not cache archives, and objects that belong to another repository or another ref
but happen to share the listing prefix, are never touched.

Caches saved with `scoped-to-ref: false` have no ref in their key. Prune them with a separate step
that also sets `scoped-to-ref: false` and leaves `ref` empty: the pattern is then resolved without
`${ref}`, exactly as the main action resolves it, and keys that carry a ref segment where the ref
would be are left for a ref-scoped prune. Each mode only prunes caches saved the same way.

Among candidates, only those whose `LastModified` is older than `older-than-days` are deleted.
Deletion happens one `DeleteObject` call per key (up to 8 in flight at a time), rather than a
single batch delete: Google Cloud Storage's S3 interoperability layer does not support
multi-object delete, and this keeps behavior identical across providers.

## Scope: repository, prefix and ref

By default (`scoped-to-repository: true`), pruning is scoped to the current repository, matching
how caches are saved. Set `prefix` to further narrow it, exactly as with the main action.

Leaving `ref` empty prunes caches under **every** ref in scope, not just the current branch — this
is usually what you want for a scheduled cleanup job. Set `ref` to prune a single ref instead. It
must be the full ref, such as `refs/heads/main` or `refs/pull/12/merge`: caches are saved under
the full ref, so `main` matches nothing. The step warns when `ref` does not start with `refs/`.

The action refuses to run when the result would be unsafe:

- **No fixed listing prefix.** If the `s3-key-pattern` leaves nothing fixed before the first part
  that varies (for example `scoped-to-repository: false` with no `prefix`, or a pattern that starts
  with `${ref}` while `ref` is empty), prune would have to scan the whole bucket. The step fails
  and asks you to set `prefix`, keep `scoped-to-repository` enabled, or set `ref`.
- **A repository that cannot be told apart.** If every `${GITHUB_REPOSITORY}` in the pattern shares
  a path segment with `${key}`, `${version}` or a `${ref}` before it (for example
  `${key}-${GITHUB_REPOSITORY}/`), another repository's object keys could match yours, so the step
  fails. Separate `${GITHUB_REPOSITORY}` from them with `/`. `${GITHUB_REPOSITORY}-${ref}` is
  fine: an encoded ref always starts with `refs%2F`, which no repository name contains.
- **No `${archive_filename}`.** Without it in the pattern, prune cannot tell cache archives from
  other objects, so the step fails.
- **A ref without a ref scope.** Setting `ref` while `scoped-to-ref` is `false` fails the step,
  because those cache keys contain no ref.
- **A ref that cannot be told apart.** With `ref` set, the step fails when the pattern has no
  `${ref}`, or when every `${ref}` shares a path segment with `${key}`, `${version}` or another
  `${ref}`. Leave `ref` empty to prune every ref instead.
