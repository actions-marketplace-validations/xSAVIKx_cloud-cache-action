# Changelog

All notable changes to Cloud Cache Action are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The floating `v1` tag always
points at the latest `v1.x.y` release.

## [Unreleased]

## [1.2.0] - 2026-09-14

No breaking changes. Caches saved by v1.1 stay valid, and the default save and restore paths still
work the same way, apart from the additions below.

### Added

- **`cloud-cache-action/prune` sub-action** that deletes cache archives older than
  `older-than-days`. It supports `ref`, `scoped-to-ref`, `scoped-to-repository`, `prefix` and
  `dry-run`.
  - It only deletes objects whose whole key matches the resolved `s3-key-pattern`, so other
    repositories, other refs and non-archive objects under the same listing prefix are never
    touched.
  - It refuses to run when a pattern can't be scoped safely.
  - An invalid `dry-run` value fails the step before any S3 call.
- **Archive integrity.** File-mode saves store a sha256 of the archive in the
  `cloud-cache-sha256` object metadata, and restores verify it.
  - A mismatch counts as a cache miss with a warning.
  - It only fails the step when both `dual-cache` and `dual-cache-strict` are `true`.
  - Objects without the metadata (any v1.1 cache, or a streamed save) skip the check.
- **Safe concurrent saves.** Saves send `If-None-Match: *`, so when two jobs save the same key,
  the first one wins and the second keeps the existing cache.
  - If a provider rejects the condition, the save retries once without it and doesn't send it
    again for the rest of the run.
  - A `409 ConditionalRequestConflict` is retried once.
  - Providers that ignore the condition, such as Garage, keep last-writer-wins.
- **Job summary.** Restore and save each write a step summary table with the key, hit and
  source, size and duration. The new `job-summary` input defaults to `true`.
- **Opt-in streaming** (`streaming: true`, default `false`): pipes tar straight to a multipart
  upload and downloads straight into tar, with no temporary archive file.
  - The file-based path stays the default and is unchanged.
  - A streamed upload is only completed after tar exits successfully, so a failed tar never
    leaves a truncated cache.
  - It falls back to file mode for BSD tar with zstd on Windows and for rejected conditions.
- **Maintenance.** Dependabot for npm and GitHub Actions, with minor and patch updates grouped
  and major updates proposed separately.
- **Release workflow** (`.github/workflows/release.yml`), which runs when a GitHub release is
  published.
  - It verifies the tag against `package.json` and checks that `dist` is up to date.
  - It then moves the major tag, but only for the highest stable release of that major.

### Changed

- The main action, `restore` and `save` gain the `job-summary` and `streaming` inputs.
- A bare `$ref`, `$key`, `$prefix`, `$version`, `$archive_filename` or `$GITHUB_REPOSITORY` in
  `s3-key-pattern` is no longer expanded from the environment. It stays literal and logs one
  warning per name.

### Fixed

- A strict dual-cache save where `path` matches nothing no longer fails the step. The GitHub
  tier's "Path Validation Error" now counts as a skipped save, as it already did for the S3 tier.
- With `scoped-to-repository: false` or `scoped-to-ref: false`, removing the placeholder no longer
  leaves a leading, doubled or trailing `/`. A `/` is only removed when the placeholder fills a
  whole path segment, so custom patterns keep their v1.1 keys.
- When `CompleteMultipartUpload` fails (for example, a lost save race), the multipart upload is
  aborted instead of leaving billed parts behind.
- Errors rewrapped by the restore and save steps keep the original error as `cause`.

## [1.1.0] - 2026-09-13

v1.1 is a correctness release. `path` now behaves like actions/cache, S3 keys carry the Git ref
and a cache version, and dual-cache strict mode actually fails the step.

### Breaking changes

- **New S3 key layout:** `${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}`.
  - `${version}` hashes the `path` patterns, the compression method and, on Windows,
    `enableCrossOsArchive`.
  - Caches saved by v1.0 are not found, and are rebuilt once.
- **Ref-scoped restores, like actions/cache:** the current ref first, then the pull request base
  branch, then the default branch. The new `scoped-to-ref` input (default `true`) shares caches
  across all refs when set to `false`.
- **`save-always` removed:** it never worked, because `post-if` can't read inputs. Use the
  `restore` and `save` sub-actions with `if: always()` instead.
- **`dual-cache-strategy: independent` removed:** it now logs a warning and behaves as `backfill`.
- **`dual-cache-strict: true` fails the step** on tier errors during both restore and save.

### Fixed

- `path` patterns go through `@actions/glob`, so `~`, `**` and `!` exclusions work. Archives store
  paths relative to `GITHUB_WORKSPACE`.
- **tar selection matches actions/cache:**
  - GNU tar on Linux.
  - `gtar` or BSD tar on macOS.
  - Git's GNU tar or System32 tar on Windows, with two-step zstd for BSD tar and
    `MSYS=winsymlinks:nativestrict` for symlinks.
  - File names starting with `-` can no longer inject tar options.
- **Restore-key matching:**
  - Listing reads every page instead of stopping after 100 keys.
  - The primary key is tried as a prefix before `restore-keys`.
  - Keys containing `/` or `$` survive a round trip.
- Failed downloads or extractions count as a cache miss with a warning instead of failing the job.
- `backfill` checks the other tier first and only uploads to a tier that doesn't already have the
  key.
- **Retries:**
  - `retry-count` sets the SDK's standard retries.
  - Stream retries only cover network failures the SDK doesn't retry itself.
  - Permanent errors such as 403 are no longer retried.
  - `retry-count: 0` is honoured.
- S3-compatible providers only receive request checksums when S3 requires them.
- Unknown providers, invalid booleans and enum values, and a lone access or secret key now log a
  warning.
- The post step reuses the restore step's settings and compression method, so both compute the
  same object key.
- The `restore` and `save` sub-actions use valid Marketplace icons.

### Testing

- Unit tests on real temporary directories, real tar round trips, and a contract test that keeps
  all `action.yml` manifests in sync with the code.
- Integration tests against SeaweedFS, MinIO and Garage.
- **CI on Linux, macOS and Windows:**
  - per-OS round trips and post-step saves
  - cross-OS restores
  - dual-cache against the live GitHub Actions Cache
  - a strict-mode failure check
  - actionlint
- A nightly live cross-OS restore on Cloudflare R2.

## [1.0.0] - 2026-09-11

First stable release. Inputs and outputs are unchanged from 0.1.0.

### Added

- Dedicated live provider verification workflows for Amazon S3, Cloudflare R2 and Google Cloud
  Storage.
- The repository's own CI and documentation deployment use the action.

### Changed

- Documentation and examples reference `@v1`.
- The action description was shortened to fit the Marketplace's 125-character limit.

## [0.1.0] - 2026-09-11

Initial pre-release.

### Added

- **Drop-in replacement for `actions/cache`:**
  - Inputs `path`, `key`, `restore-keys`, `fail-on-cache-miss`, `lookup-only`,
    `enableCrossOsArchive`, `read-only` and `save-always`.
  - Outputs `cache-hit`, `cache-primary-key` and `cache-matched-key`.
  - Runs on Node 24.
- **Storage:** any S3-compatible storage (AWS S3, Cloudflare R2, Google Cloud Storage, Backblaze B2,
  Fastly Object Storage, Garage, SeaweedFS, MinIO), with custom endpoints, path-style addressing
  and session tokens.
- **Dual-caching** to S3 and the GitHub Actions Cache, with `restore-priority`,
  `dual-cache-strategy` and `dual-cache-strict`.
- **Custom S3 key templates** (`s3-key-pattern`) with `prefix` and `scoped-to-repository`.
- zstd compression with a gzip fallback, chunked multipart uploads and retries.
- `restore` and `save` sub-actions.

[Unreleased]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/xSAVIKx/cloud-cache-action/releases/tag/v0.1.0
