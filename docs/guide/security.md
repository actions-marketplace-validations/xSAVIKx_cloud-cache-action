# Security and Least-Privilege Policies

This guide explains what the cache protects, what it does not protect, and which permissions each
job needs. It holds the one full set of policies. The provider pages link here.

## The trust boundary

Anyone who can write to the cache bucket can change what a later restore extracts. A restore
unpacks the archive on the runner, and the next steps then run code from it. Treat write access to
the bucket as write access to every job that restores from it.

The action reduces the risk in three ways:

- **Ref scoping.** A restore searches only the current ref, the pull request base branch and the
  default branch. A save writes only to the current ref. A pull request branch cannot replace the
  cache of the default branch by using the action. See [S3 Key Templating](./s3-key-patterns.md).
- **Integrity check.** Every save records the sha256 checksum of the archive. A restore hashes the
  download and compares it. A mismatch counts as a cache miss. This finds a damaged archive. It
  does not find an archive that an attacker built with a matching checksum tag.
- **Conditional create.** A save uses `If-None-Match: *`. On a provider that enforces it, a save
  does not overwrite an existing key.

The action does not sign caches. The checksum is stored beside the archive, so a writer who can
change the archive can change the checksum too. Ref scoping is a naming rule in the action. It is
not an access rule in the bucket. A credential that can write to the repository prefix can write to
any ref in it. Use the policies below to limit what each credential can do.

## Pull requests from forks

GitHub does not give repository secrets to a workflow that a fork pull request starts. The action
then has no credentials, and the S3 tier cannot connect. Use the GitHub cache tier for these runs,
or accept a cache miss.

> [!WARNING]
> Do not use `pull_request_target` to restore a cache in a job that runs code from the pull
> request. That event gives secrets to the job. A restore then extracts files that an untrusted
> branch could influence, and the job runs them with your credentials.

Follow these rules for `pull_request_target`:

1. Do not check out or run the pull request code in the same job that holds the S3 credentials.
2. Do not restore a cache in a job that runs untrusted code with a write credential.
3. If a job must restore, give it a read-only credential and set `read-only: true`.

For ordinary `pull_request` jobs from the same repository, use a read-only pattern. The job
restores the cache and never saves. Only a trusted job on the default branch saves.

```yaml
# Pull request job: read-only key, no save.
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-actions-cache-bucket
    access-key: ${{ secrets.CACHE_READ_ACCESS_KEY }}
    secret-key: ${{ secrets.CACHE_READ_SECRET_KEY }}
    read-only: true
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: node_modules
```

`read-only: true` makes the post step skip the save. The read-only key makes the storage refuse a
save even if a step changes the workflow. Use both. A trusted job on the default branch uses the
read-write key and saves.

## Which S3 calls the action makes

The table lists every S3 call in the code. Each row names the policy action and the feature that
sends the call.

| S3 call                                                                  | Policy action                                      | Sent by                                                                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ListObjectsV2`                                                          | `s3:ListBucket`                                    | Restore (the `restore-keys` search), `explain`, the `inspect` sub-action, and `prune`                                             |
| `HeadObject`                                                             | `s3:GetObject`                                     | Restore (exact-key lookup), save (existence check and the ownership check after a streamed save), `inspect`                       |
| `GetObject` (also with a `Range` header)                                 | `s3:GetObject`                                     | Restore (download, and the parallel ranged download of large archives)                                                            |
| `PutObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload` | `s3:PutObject`                                | Save (the upload helper in the AWS SDK sends these)                                                                               |
| `PutObjectTagging`                                                       | `s3:PutObjectTagging`                              | Save: the `tags` input, and the checksum tag of a streamed save. A `PutObject` that carries a tag header needs this action too    |
| `GetObjectTagging`                                                       | `s3:GetObjectTagging`                              | Restore, when the object has no checksum metadata (a streamed save stores the checksum as a tag)                                  |
| `CopyObject`                                                             | `s3:GetObject` and `s3:PutObject` (and `s3:PutObjectTagging` per AWS for the copied tags) | Save: the fallback that writes the checksum metadata after a streamed save                                  |
| `AbortMultipartUpload`                                                   | `s3:AbortMultipartUpload`                          | Save, when an upload fails or stops. Also `prune` with `abort-uploads-older-than-hours`                                           |
| `ListMultipartUploads`                                                   | `s3:ListBucketMultipartUploads`                    | `prune` with `abort-uploads-older-than-hours`                                                                                     |
| `DeleteObject`                                                           | `s3:DeleteObject`                                  | `prune` only, when it is not a dry run                                                                                            |

The action never sends `ListParts`, so `s3:ListMultipartUploadParts` is not needed. The checksum
tag calls are optional: if a provider or a policy refuses them, the save falls back to the copy and
the restore skips the integrity check, with a warning in the log. Grant them to keep the integrity
check.

A restore needs `s3:ListBucket`, `s3:GetObject` and `s3:GetObjectTagging`. A save needs
`s3:ListBucket`, `s3:GetObject`, `s3:PutObject`, `s3:PutObjectTagging`, `s3:AbortMultipartUpload`.
Only `prune` needs `s3:DeleteObject` and `s3:ListBucketMultipartUploads`. Give `prune` its own
credential.

## Scope of the policies

The default object key is `<owner>/<repo>/<prefix><ref>/<key>/<version>/<file>`. All
policies below grant access to the prefix `my-org/my-repo/` in the bucket
`my-actions-cache-bucket`. Replace both values. If you use the `prefix` input, the prefix goes after
the repository name, so the repository prefix still covers it. If you set
`scoped-to-repository: false` or a custom `s3-key-pattern`, use the fixed leading part of your
pattern instead.

## AWS S3

### Read-write policy (restore and save)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListRepositoryPrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::my-actions-cache-bucket",
      "Condition": {
        "StringLike": { "s3:prefix": "my-org/my-repo/*" }
      }
    },
    {
      "Sid": "ReadWriteRepositoryObjects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:GetObjectTagging",
        "s3:PutObjectTagging",
        "s3:AbortMultipartUpload"
      ],
      "Resource": "arn:aws:s3:::my-actions-cache-bucket/my-org/my-repo/*"
    }
  ]
}
```

### Read-only policy (restore only)

Use this policy for pull request jobs together with `read-only: true`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListRepositoryPrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::my-actions-cache-bucket",
      "Condition": {
        "StringLike": { "s3:prefix": "my-org/my-repo/*" }
      }
    },
    {
      "Sid": "ReadRepositoryObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectTagging"],
      "Resource": "arn:aws:s3:::my-actions-cache-bucket/my-org/my-repo/*"
    }
  ]
}
```

### Prune policy

Attach this policy to the credential of the [prune](./pruning.md) workflow. Prune lists, deletes,
and (with `abort-uploads-older-than-hours`) lists and aborts incomplete uploads. Omit the last
statement if you do not use that input.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListRepositoryPrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::my-actions-cache-bucket",
      "Condition": {
        "StringLike": { "s3:prefix": "my-org/my-repo/*" }
      }
    },
    {
      "Sid": "DeleteRepositoryObjects",
      "Effect": "Allow",
      "Action": "s3:DeleteObject",
      "Resource": "arn:aws:s3:::my-actions-cache-bucket/my-org/my-repo/*"
    },
    {
      "Sid": "AbortIncompleteUploads",
      "Effect": "Allow",
      "Action": ["s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::my-actions-cache-bucket/my-org/my-repo/*"
    },
    {
      "Sid": "ListIncompleteUploads",
      "Effect": "Allow",
      "Action": "s3:ListBucketMultipartUploads",
      "Resource": "arn:aws:s3:::my-actions-cache-bucket"
    }
  ]
}
```

The last statement has no prefix condition. This guide did not verify that AWS accepts `s3:prefix`
for `s3:ListBucketMultipartUploads`, so it does not use one there. The action filters the
list to the prune scope itself. If you prune several repositories with one credential, widen the
`Resource` ARNs and the `s3:prefix` value to match.

> [!NOTE]
> A missing key returns `403` instead of `404` when the credential lacks `s3:ListBucket`. Keep
> `s3:ListBucket` in every policy, with the prefix condition.

For the role trust policy, the OIDC workflow and the static key option, see [AWS S3
Setup](../providers/aws-s3.md).

## Cloudflare R2

R2 API tokens use permission groups, not policy JSON. Create the token in the Cloudflare dashboard
under **R2** > **Manage R2 API Tokens**, and choose a permission group:

| Job                           | Permission group        | Scope                           |
| ----------------------------- | ----------------------- | ------------------------------- |
| Restore only (pull requests)  | **Object Read only**    | Specific buckets: the cache bucket |
| Restore and save, and prune   | **Object Read & Write** | Specific buckets: the cache bucket |

Cloudflare documents that only the two Object groups can be limited to chosen buckets. The Admin
groups are account-wide, so do not use them for CI. Cloudflare documents scope at the bucket level
only. This guide found no prefix scope for R2 tokens. Use one bucket for each trust level, for
example one bucket for the cache of a single repository, if you need a hard boundary.

The Cloudflare page lists no narrower group than **Object Read & Write**. This guide therefore
assumes that a token which saves can also delete. Keep the read-write token out of pull request jobs.

Checked on 2026-10-20: <https://developers.cloudflare.com/r2/api/tokens/>.

## Google Cloud Storage

GCS accepts S3 requests that an HMAC key signs. The key has the permissions of its service account.
Create the HMAC key for a dedicated service account, as the [Google Cloud
Storage](../providers/google-cloud-storage.md) page describes. Then limit the service account to
the repository prefix with an IAM condition on the role binding for the bucket.

Google documents this condition expression for an object name prefix:

```text
resource.name.startsWith('projects/_/buckets/my-actions-cache-bucket/objects/my-org/my-repo/')
```

Bind a role to the service account on the bucket with this condition:

- Read-write job: **Storage Object User** (`roles/storage.objectUser`).
- Read-only job: **Storage Object Viewer** (`roles/storage.objectViewer`).

Google documents that conditional role bindings need IAM policy version 3. Google also suggests
one service account with the Storage Object Viewer role for reads, and a separate service account
with the Storage Object Creator role for writes, instead of a broad role.

This guide did not verify these points, so test them before you rely on them:

- The exact JSON or `gcloud` form of the conditional binding. Use the Google Cloud console or the
  current Google documentation, and not a copy from this page.
- Whether an object list request passes the condition. Run a restore with `explain: true` after you
  add the condition, and check that the lookup lists the prefix.
- Which permission the S3 multipart calls need. The `prune` option `abort-uploads-older-than-hours`
  and an aborted upload use multipart calls, and a role that lacks the multipart permissions can
  refuse them.

Checked on 2026-10-20: <https://docs.cloud.google.com/storage/docs/authentication/hmackeys>.
The condition expression comes from the Cloud Storage IAM conditions documentation, which this
guide read through a search result and not through the full page. Read it before use.

## MinIO and RustFS

Both servers read an S3-style policy document. Use the AWS read-write policy above with the
bucket name and prefix changed. The example below uses the bucket `ci-cache` and a prefix.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::ci-cache",
      "Condition": {
        "StringLike": { "s3:prefix": ["my-org/my-repo/*"] }
      }
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:GetObjectTagging",
        "s3:PutObjectTagging",
        "s3:AbortMultipartUpload"
      ],
      "Resource": "arn:aws:s3:::ci-cache/my-org/my-repo/*"
    }
  ]
}
```

For a read-only or prune credential, use the same actions as in the AWS sections. Add `s3:DeleteObject`
for prune. Test the `s3:prefix` condition on your server version. The action sends `Prefix` on
every list request, but this guide did not verify condition support on each server. If a restore
finds no cache after you add the condition, remove the condition and keep the object ARN scope.

The [MinIO](../providers/minio.md) page shows how to load the policy with `mc admin policy create`.
